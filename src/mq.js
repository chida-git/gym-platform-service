// src/mq.js
const amqp = require('amqplib')

let conn, ch, ready = false
const url = process.env.RABBIT_URL || 'amqp://localhost'
const exchange = process.env.RABBIT_EXCHANGE || 'gymspot.events'

async function connect() {
  // timeout manuale di protezione in caso di socket bloccato
  const guard = new Promise((_, rej) => setTimeout(() => rej(new Error('AMQP connect timeout')), connTimeout + 1000))
  try {
    const c = await Promise.race([
      amqp.connect(url, { timeout: connTimeout }), // socket timeout lato amqplib
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

async function publish(routingKey, payload) {
  const channel = await ensure()
  console.log(channel)
  const body = Buffer.from(JSON.stringify(payload))
  console.log(body)
  console.log(exchange, routingKey)
  await channel.publish(exchange, routingKey, body, { persistent: true })
  // wait for broker acks (confirm channel)
  await channel.waitForConfirms()
}

module.exports = { publish }
