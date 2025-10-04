// src/mq.js
const amqp = require('amqplib');

let conn, ch, ready = false;
let connecting = null;

// --- Config ---
const RAW_URL  = process.env.RABBIT_URL || '';
const HOST     = process.env.RABBIT_HOST || '127.0.0.1';
const PORT     = +(process.env.RABBIT_PORT || 5672);
const USER     = encodeURIComponent(process.env.RABBIT_USER || 'guest');
const PASS     = encodeURIComponent(process.env.RABBIT_PASS || 'guest');
const VHOST    = encodeURIComponent(process.env.RABBIT_VHOST || '/');

const HEARTBEAT = +(process.env.RABBIT_HEARTBEAT || 30);
const CONN_TO   = +(process.env.RABBIT_CONN_TIMEOUT || 8000);

// naming compatibile con entrambi gli schemi di env
const EXCHANGE  = process.env.CATALOG_EXCHANGE || process.env.RABBIT_EXCHANGE || 'gym.catalog';
const DLX       = process.env.DLX_EXCHANGE || 'gym.catalog.dlx';
const QUEUE     = process.env.CATALOG_QUEUE || 'fe-catalog-consumer';

// --- URL robusto ---
function buildUrl() {
  if (RAW_URL.trim()) {
    const u = new URL(RAW_URL);
    if (!u.searchParams.has('heartbeat')) u.searchParams.set('heartbeat', HEARTBEAT);
    return u.toString();
  }
  const u = new URL(`amqp://${USER}:${PASS}@${HOST}:${PORT}/${VHOST}`);
  u.searchParams.set('heartbeat', HEARTBEAT);
  return u.toString();
}
const URL_AMQP = buildUrl();

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function connectWithTimeout() {
  const guard = new Promise((_, rej) =>
    setTimeout(() => rej(new Error('AMQP connect timeout')), CONN_TO)
  );
  return Promise.race([amqp.connect(URL_AMQP), guard]);
}

async function setupTopology(channel) {
  await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
  await channel.assertExchange(DLX, 'topic', { durable: true });
  await channel.assertQueue(QUEUE, { durable: true, deadLetterExchange: DLX });
  await channel.bindQueue(QUEUE, EXCHANGE, 'plan.upsert.*');
  await channel.bindQueue(QUEUE, EXCHANGE, 'plan.archive.*');
  await channel.bindQueue(QUEUE, EXCHANGE, 'price.upsert.*');
  await channel.bindQueue(QUEUE, EXCHANGE, 'price.archive.*');
}

async function connect() {
  console.log('[AMQP] connecting to', URL_AMQP);
  const c = await connectWithTimeout();

  c.on('close', (e) => { ready = false; ch = null; console.warn('[AMQP] close:', e?.message || e); });
  c.on('error', (e) => { console.error('[AMQP] error:', e?.message || e); });

  const channel = await c.createConfirmChannel();
  await setupTopology(channel);

  channel.on('error', (e) => console.error('[AMQP] channel error:', e?.message || e));
  channel.on('close', () => console.warn('[AMQP] channel closed'));

  conn = c;
  ch = channel;
  ready = true;
  console.log('[AMQP] ready, exchange:', EXCHANGE);
  return ch;
}

async function ensure() {
  if (ready && ch) return ch;
  if (connecting) return connecting;
  connecting = (async () => {
    while (!ready) {
      try { return await connect(); }
      catch (e) { console.error('[AMQP] connect failed:', e?.message || e); await sleep(1500); }
    }
    return ch;
  })();
  try { return await connecting; }
  finally { connecting = null; }
}

async function publish(routingKey, payload, headers = {}) {
  const channel = await ensure();
  const body = Buffer.from(JSON.stringify(payload));
  channel.publish(EXCHANGE, routingKey, body, {
    persistent: true,
    contentType: 'application/json',
    contentEncoding: 'utf-8',
    timestamp: Date.now(),
    headers
  });
  await channel.waitForConfirms();
}

async function publishSafe(routingKey, payload, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try { await publish(routingKey, payload); return true; }
    catch (e) {
      lastErr = e;
      console.warn(`[AMQP] publish attempt ${i}/${attempts} failed:`, e?.message || e);
      await sleep(300 * i);
    }
  }
  // non rilanciare se vuoi che l’API non fallisca:
  // return false;
  throw lastErr;
}

module.exports = { publishSafe, EXCHANGE, DLX, QUEUE };
