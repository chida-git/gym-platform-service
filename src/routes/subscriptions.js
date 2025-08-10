const router = require('express').Router();
const Joi = require('joi');
const { pool } = require('../db');
const { addDays, now } = require('../util');

router.post('/', async (req, res, next) => {
  const schema = Joi.object({ user_id: Joi.number().required(), gym_id: Joi.number().required(), plan_id: Joi.number().required(), paid: Joi.boolean().default(true) });
  try {
    const input = await schema.validateAsync(req.body);
    const [[plan]] = await pool.query('SELECT * FROM plans WHERE id=? AND gym_id=? AND active=1', [input.plan_id, input.gym_id]);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const startAt = now();
    let endAt = null, entriesRemaining = null;
    if (['monthly','annual','trial'].includes(plan.plan_type) && plan.duration_days) endAt = addDays(startAt, plan.duration_days);
    if (plan.plan_type === 'pack') entriesRemaining = plan.entries_total || 0;
    if (plan.plan_type === 'daypass') { entriesRemaining = 1; endAt = addDays(startAt, 1); }
    const status = input.paid ? 'active' : 'pending';
    const [resSub] = await pool.query(
      `INSERT INTO subscriptions (user_id, gym_id, plan_id, status, start_at, end_at, auto_renew, entries_remaining, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, NOW())`, [input.user_id, input.gym_id, input.plan_id, status, startAt, endAt, entriesRemaining]);
    const subId = resSub.insertId;
    await pool.query('INSERT INTO subscription_events (subscription_id, event_type, payload) VALUES (?, "created", JSON_OBJECT("paid", ?))', [subId, input.paid]);
    res.status(201).json({ id: subId, status, start_at: startAt, end_at: endAt, entries_remaining: entriesRemaining });
  } catch (e) { next(e); }
});

module.exports = router;
