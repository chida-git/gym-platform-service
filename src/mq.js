// src/mq.js
const amqp = require('amqplib')

let conn, ch, ready = false
const url = process.env.RABBIT_URL || 'amqp://localhost'
const exchange = process.env.RABBIT_EXCHANGE || 'gymspot.events'

async function connect() {
    console.log(exchange)
  conn = await amqp.connect(url)
  console.log(url)
  conn.on('close', () => { ready = false; setTimeout(connect, 2000) })
  conn.on('error', () => {}) // già gestita
  console.log(".10")
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
  console.log(channel)
  const body = Buffer.from(JSON.stringify(payload))
  console.log(body)
  console.log(exchange, routingKey)
  await channel.publish(exchange, routingKey, body, { persistent: true })
  // wait for broker acks (confirm channel)
  await channel.waitForConfirms()
}

module.exports = { publish }
