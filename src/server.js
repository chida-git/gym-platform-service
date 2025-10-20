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
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-None-Match');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
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
app.use('/routes', require('./routes/routes'));
app.use('/schedule', require('./routes/schedule_course'));
app.use('/course', require('./routes/course_types'));
app.use('/weekly_slots', require('./routes/weekly_slots'));
app.use('/extras', require('./routes/extras'));
app.use('/extras_gym', require('./routes/gym_extras'));

(async () => {
  try {
    await initMq();
  } catch (e) {
    console.error('AMQP not ready at boot:', e.message);
  }
})();

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API listening on port ${port}`));
