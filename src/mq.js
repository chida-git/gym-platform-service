// src/mq.js
const amqp = require('amqplib');

let conn, ch, ready = false;
let connecting = null;

// ---- Connessione (identica al tuo file attuale) ----------------------------
const RAW_URL  = process.env.RABBIT_URL || '';
const HOST     = process.env.RABBIT_HOST || '127.0.0.1';
const PORT     = +(process.env.RABBIT_PORT || 5672);
const USER     = encodeURIComponent(process.env.RABBIT_USER || 'guest');
const PASS     = encodeURIComponent(process.env.RABBIT_PASS || 'guest');
const VHOST    = encodeURIComponent(process.env.RABBIT_VHOST || '/');
const HEARTBEAT = +(process.env.RABBIT_HEARTBEAT || 30);
const CONN_TO   = +(process.env.RABBIT_CONN_TIMEOUT || 8000);

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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function connectWithTimeout() {
  const guard = new Promise((_, rej) =>
    setTimeout(() => rej(new Error('AMQP connect timeout')), CONN_TO)
  );
  return Promise.race([amqp.connect(URL_AMQP), guard]);
}

// ---- Topologie multiple -----------------------------------------------------
// NB: i default combaciano con quelli che hai in Rabbit (screenshot)
const TOPOLOGIES = [
  {
    key: 'catalog',
    exchange: process.env.CATALOG_EXCHANGE || process.env.RABBIT_EXCHANGE || 'gym.catalog',
    dlx:      process.env.DLX_EXCHANGE     || 'gym.catalog.dlx',
    queue:    process.env.CATALOG_QUEUE    || 'fe-catalog-consumer',
    dlqRk:    process.env.DLX_ROUTING_KEY  || 'dlq',
    dlqQueue: process.env.DLQ_QUEUE        || 'fe-catalog-consumer.dlq',
    bindings: [
      'plan.upsert.*', 'plan.archive.*',
      'price.upsert.*','price.archive.*',
      'personal.upsert.*'
    ],
  },
  {
    key: 'course_types',
    exchange: process.env.COURSE_TYPES_EXCHANGE || 'gym.course_types',
    dlx:      process.env.COURSE_TYPES_DLX      || 'gym.course_types.dlx',
    queue:    process.env.COURSE_TYPES_QUEUE    || 'fe-course-types-consumer',
    dlqRk:    process.env.COURSE_TYPES_DLQ_RK   || 'dlq',
    dlqQueue: process.env.COURSE_TYPES_DLQ      || 'fe-course-types-consumer.dlq',
    bindings: ['course_type.upsert.*','course_type.archive.*','course_type.delete.*'],
  },
  {
    key: 'halls',
    exchange: process.env.HALLS_EXCHANGE || 'gym.halls',
    dlx:      process.env.HALLS_DLX      || 'gym.halls.dlx',
    queue:    process.env.HALLS_QUEUE    || 'fe-halls-consumer',
    dlqRk:    process.env.HALLS_DLQ_RK   || 'dlq',
    dlqQueue: process.env.HALLS_DLQ      || 'fe-halls-consumer.dlq',
    bindings: ['hall.create.*','hall.update.*','extra.add.*','extra.update.*','extra.remove.*'],
  },
  {
    key: 'equipment',
    exchange: process.env.HALLS_EXCHANGE || 'gym.equipment',
    dlx:      process.env.HALLS_DLX      || 'gym.equipment.dlx',
    queue:    process.env.HALLS_QUEUE    || 'fe-equipment-consumer',
    dlqRk:    process.env.HALLS_DLQ_RK   || 'dlq',
    dlqQueue: process.env.HALLS_DLQ      || 'fe-equipment-consumer.dlq',
    bindings: ['equipment.create.*','equipment.update.*', 'categories.create.*', 'categories.update.*', 'categories.delete.*'],
  },
];

// mappa rapida per pubblicazione: key -> exchange
const EXCHANGES_BY_KEY = Object.fromEntries(TOPOLOGIES.map(t => [t.key, t.exchange]));

// ---- Setup di TUTTE le topologie su un unico channel -----------------------
async function setupAllTopologies(channel) {
  for (const t of TOPOLOGIES) {
    // exchanges
    await channel.assertExchange(t.exchange, 'topic', { durable: true });
    if (t.dlx) await channel.assertExchange(t.dlx, 'topic', { durable: true });

    if (t.queue) {
      await channel.assertQueue(t.queue, {
        durable: true,
        deadLetterExchange: t.dlx,
        deadLetterRoutingKey: t.dlqRk || 'dlq',
      });
      for (const rk of (t.bindings || [])) {
        await channel.bindQueue(t.queue, t.exchange, rk);
      }

      // DLQ fisica
      const dlqName = t.dlqQueue || `${t.queue}.dlq`;
      await channel.assertQueue(dlqName, { durable: true });
      await channel.bindQueue(dlqName, t.dlx, t.dlqRk || 'dlq');
    }
  }
}

// ---- Connect / Ensure -------------------------------------------------------
async function connect() {
  console.log('[AMQP] connecting to', URL_AMQP);
  const c = await connectWithTimeout();

  c.on('close', (e) => { ready = false; ch = null; console.warn('[AMQP] close:', e?.message || e); });
  c.on('error', (e) => { console.error('[AMQP] error:', e?.message || e); });

  const channel = await c.createConfirmChannel();
  await setupAllTopologies(channel);

  channel.on('error', (e) => console.error('[AMQP] channel error:', e?.message || e));
  channel.on('close', () => console.warn('[AMQP] channel closed'));

  conn = c;
  ch = channel;
  ready = true;
  console.log('[AMQP] ready. Exchanges:', Object.values(EXCHANGES_BY_KEY).join(', '));
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

// ---- Publish helpers --------------------------------------------------------
async function publishToExchange(exchange, routingKey, payload, headers = {}) {
  const channel = await ensure();
  const body = Buffer.from(JSON.stringify(payload));
  channel.publish(exchange, routingKey, body, {
    persistent: true,
    contentType: 'application/json',
    contentEncoding: 'utf-8',
    timestamp: Date.now(),
    headers
  });
  await channel.waitForConfirms();
}

async function publishTo(keyOrExchange, routingKey, payload, headers = {}) {
  // key: 'catalog' | 'course_types' | 'halls'  oppure exchange stringa completa
  const exchange = EXCHANGES_BY_KEY[keyOrExchange] || keyOrExchange;
  if (!exchange) throw new Error(`Unknown exchange key: ${keyOrExchange}`);
  return publishToExchange(exchange, routingKey, payload, headers);
}

async function publishSafe(keyOrExchange, routingKey, payload, attempts = 3, headers = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try { await publishTo(keyOrExchange, routingKey, payload, headers); return true; }
    catch (e) { lastErr = e; console.warn(`[AMQP] publish attempt ${i}/${attempts} failed:`, e?.message || e); await sleep(300 * i); }
  }
  throw lastErr;
}

// ---- Exports ---------------------------------------------------------------
module.exports = {
  ensure,
  publishTo,          // publishTo('catalog', 'rk', payload)
  publishToExchange,  // publishToExchange('gym.halls', 'rk', payload)
  publishSafe,        // retry con backoff
  EXCHANGES_BY_KEY,
  TOPOLOGIES,
};
