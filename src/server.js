require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { setupSwagger } = require('./swagger');
const app = express();

app.use(helmet());
app.use(cors({ origin: '*', methods: ['GET','POST','PATCH','PUT','DELETE','OPTIONS'] }));
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
//app.use('/partner', require('./routes/partner'));
app.use('/partner/access', require('./routes/access'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API listening on port ${port}`));
