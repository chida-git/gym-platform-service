const router = require('express').Router();
const Joi = require('joi');
const { pool } = require('../db');
const { addDays, now } = require('../util');

router.post('/', async (req, res, next) => {
  const schema = Joi.object({
    user_id: Joi.number().required(),
    gym_id: Joi.number().required(),
    plan_id: Joi.number().required(),
    paid: Joi.boolean().default(true)
  });
  try {
    const input = await schema.validateAsync(req.body);
    const [[plan]] = await pool.query('SELECT * FROM plans WHERE id=? AND gym_id=? AND active=1', [input.plan_id, input.gym_id]);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const startAt = now();
    let endAt = null;
    let entriesRemaining = null;
    const type = plan.plan_type;
    if ((type === 'monthly' || type === 'annual' || type === 'trial') && plan.duration_days) {
      endAt = addDays(startAt, plan.duration_days);
    }
    if (type === 'pack') entriesRemaining = plan.entries_total || 0;
    if (type === 'daypass') { entriesRemaining = 1; endAt = addDays(startAt, 1); }

    const status = input.paid ? 'active' : 'pending';
    const [resSub] = await pool.query(
      `INSERT INTO subscriptions (user_id, gym_id, plan_id, status, start_at, end_at, auto_renew, entries_remaining, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, NOW())`,
      [input.user_id, input.gym_id, input.plan_id, status, startAt, endAt, entriesRemaining]
    );
    const subId = resSub.insertId;
    await pool.query('INSERT INTO subscription_events (subscription_id, event_type, payload) VALUES (?, "created", JSON_OBJECT("paid", ?))', [subId, input.paid]);

    res.status(201).json({ id: subId, status, start_at: startAt, end_at: endAt, entries_remaining: entriesRemaining });
  } catch (e) { next(e); }
});

router.post('/:id/freeze', async (req, res, next) => {
  try {
    const id = +req.params.id;
    const days = Math.max(1, Math.min(30, +(req.body.days || 7)));
    const [[sub]] = await pool.query('SELECT * FROM subscriptions WHERE id=?', [id]);
    if (!sub) return res.status(404).json({ error: 'Subscription not found' });
    if (!sub.end_at) return res.status(400).json({ error: 'Subscription has no end date' });

    await pool.query('UPDATE subscriptions SET end_at = DATE_ADD(end_at, INTERVAL ? DAY) WHERE id=?', [days, id]);
    await pool.query('INSERT INTO subscription_events (subscription_id, event_type, payload) VALUES (?, "freeze_applied", JSON_OBJECT("days", ?))', [id, days]);
    res.json({ ok: true, added_days: days });
  } catch (e) { next(e); }
});

module.exports = router;