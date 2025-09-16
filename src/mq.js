// src/mq.js
const amqp = require('amqplib')

let conn, ch, ready = false

// Se c'è RABBIT_URL la usiamo direttamente (consigliato quando già corretta)
const rawUrl = process.env.RABBIT_URL || ''
// Altrimenti costruiamo l'URL dai pezzi separati
const host = process.env.RABBIT_HOST || '127.0.0.1'
const port = +(process.env.RABBIT_PORT || 5672)
const user = encodeURIComponent(process.env.RABBIT_USER || 'guest')
const pass = encodeURIComponent(process.env.RABBIT_PASS || 'guest')
const vhostRaw = process.env.RABBIT_VHOST || '/'
const vhost = encodeURIComponent(vhostRaw) // '/' -> %2F
const heartbeat = +(process.env.RABBIT_HEARTBEAT || 5)
const connectionTimeout = +(process.env.RABBIT_CONN_TIMEOUT || 5000)
const exchange = process.env.RABBIT_EXCHANGE || 'gymspot.events'

// Costruisci URL se non fornito
let url = rawUrl.trim()
if (!url) {
  url = `amqp://${user}:${pass}@${host}:${port}/${vhost}?heartbeat=${heartbeat}&connection_timeout=${connectionTimeout}`
} else {
  // Se fornito, assicura parametri heartbeat/connection_timeout
  const hasQuery = url.includes('?')
  const sep = hasQuery ? '&' : '?'
  if (!url.includes('heartbeat=')) url += `${sep}heartbeat=${heartbeat}${hasQuery ? '' : ''}`
  if (!url.includes('connection_timeout=')) url += `${hasQuery ? '&' : (sep.includes('?') ? '' : '?')}connection_timeout=${connectionTimeout}`
}

async function sleep(ms){ return new Promise(r => setTimeout(r, ms)) }

async function connect() {
  console.log('[AMQP] connecting to', url)
  // Guard di timeout per evitare await infinito
  const guard = new Promise((_, rej) =>
    setTimeout(() => rej(new Error('AMQP connect timeout')), connectionTimeout + 1000)
  )
  try {
    const c = await Promise.race([
      amqp.connect(url, { timeout: connectionTimeout }),
      guard
    ])
    conn = c
    conn.on('close', (e) => { ready = false; console.warn('[AMQP] close:', e?.message || e); reconnectLoop() })
    conn.on('error', (e) => { console.error('[AMQP] error:', e?.message || e) })

    ch = await conn.createConfirmChannel()
    await ch.assertExchange(exchange, 'topic', { durable: true })
    ready = true
    console.log('[AMQP] connected, exchange ready:', exchange)
    return ch
  } catch (e) {
    ready = false
    console.error('[AMQP] connect failed:', e?.message || e)
    throw e
  }
}

async function ensure() {
  if (ready && ch) return ch
  return await connect()
}

async function reconnectLoop() {
  while (!ready) {
    try {
      await connect()
      return
    } catch (e) {
      await sleep(1500)
    }
  }
}

async function publish(routingKey, payload) {
  const channel = await ensure()
  const body = Buffer.from(JSON.stringify(payload))
  channel.publish(exchange, routingKey, body, { persistent: true })
  await channel.waitForConfirms()
}

async function publishSafe(routingKey, payload, attempts = 3) {
  let lastErr
  for (let i = 1; i <= attempts; i++) {
    try {
      await publish(routingKey, payload)
      return
    } catch (e) {
      lastErr = e
      console.warn(`[AMQP] publish attempt ${i}/${attempts} failed:`, e?.message || e)
      await sleep(300 * i)
    }
  }
  throw lastErr
}

module.exports = { publishSafe }
