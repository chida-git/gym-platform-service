require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { setupSwagger } = require('./swagger');
const app = express();
const { init: initMq } = require('./mq');

const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  // aggiungi qui eventuali domini reali della tua UI:
  // 'https://partner.gymspot.it',
]);

app.use((req, res, next) => {
  res.setHeader('Vary', 'Origin'); // per far cacheare correttamente
  next();
});

app.use(helmet());
app.use(cors({
  origin(origin, cb) {
    // consentiamo anche richieste senza Origin (server→server, curl)
    if (!origin) return cb(null, true);
    cb(null, ALLOWED_ORIGINS.has(origin));
  },
  credentials: true, // ← fondamentale con include
  methods: ['GET','POST','PATCH','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','If-None-Match'],
  exposedHeaders: ['ETag','Last-Modified'],
}));
app.options('*', cors());
app.use(rateLimit({ windowMs: 15*60*1000, max: 1000 }));
app.use(express.json());
app.use(morgan('dev'));

setupSwagger(app);

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/gyms', require('./routes/gyms'));
app.use('/plans', require('./routes/plans'));
app.use('/subscriptions', require('./routes/subscriptions'));
app.use('/bookings', require('./routes/bookings'));
app.use('/checkin', require('./routes/checkin'));
app.use('/payments', require('./routes/payments'));
app.use('/auth', require('./routes/auth'));
app.use('/partner', require('./routes/partner'));
app.use('/partner/access', require('./routes/access'));

(async () => {
  try {
    await initMq();
  } catch (e) {
    console.error('AMQP not ready at boot:', e.message);
  }
})();

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API listening on port ${port}`));
