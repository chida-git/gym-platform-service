// src/mq.js
const amqp = require('amqplib')

let conn, ch, ready = false
const url = process.env.RABBIT_URL || 'amqp://localhost'
const exchange = process.env.RABBIT_EXCHANGE || 'gymspot.events'

async function connect() {
  conn = await amqp.connect(url)
  conn.on('close', () => { ready = false; setTimeout(connect, 2000) })
  conn.on('error', () => {}) // già gestita
  ch = await conn.createConfirmChannel()
  await ch.assertExchange(exchange, 'topic', { durable: true })
  ready = true
  return ch
}

async function ensure() {
  if (ready && ch) return ch
  return await connect()
}

async function publish(routingKey, payload) {
  const channel = await ensure()
  const body = Buffer.from(JSON.stringify(payload))
  await channel.publish(exchange, routingKey, body, { persistent: true })
  // wait for broker acks (confirm channel)
  await channel.waitForConfirms()
}

module.exports = { publish }
