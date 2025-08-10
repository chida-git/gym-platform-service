const router = require('express').Router();
const Joi = require('joi');
const { pool } = require('../db');
const { makeQrToken, hashToken } = require('../util');

router.post('/', async (req, res, next) => {
  try {
    const schema = Joi.object({ user_id: Joi.number().required(), gym_id: Joi.number().required(), subscription_id: Joi.number().optional(), slot_id: Joi.number().optional() });
    const input = await schema.validateAsync(req.body);
    if (input.subscription_id) {
      const [[sub]] = await pool.query('SELECT * FROM subscriptions WHERE id=? AND user_id=? AND gym_id=? AND status="active"', [input.subscription_id, input.user_id, input.gym_id]);
      if (!sub) return res.status(400).json({ error: 'Active subscription not found' });
      if (sub.entries_remaining !== null && sub.entries_remaining <= 0) return res.status(400).json({ error: 'No entries remaining' });
    }
    if (input.slot_id) {
      const [[slot]] = await pool.query('SELECT * FROM inventory_slots WHERE id=? AND is_active=1', [input.slot_id]);
      if (!slot) return res.status(400).json({ error: 'Slot not found' });
      if (slot.available <= 0) return res.status(409).json({ error: 'Slot full' });
      await pool.query('UPDATE inventory_slots SET available = available - 1 WHERE id=? AND available > 0', [input.slot_id]);
    }
    const token = makeQrToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 1000 * 60 * 120);
    const [ins] = await pool.query(`INSERT INTO bookings (user_id, gym_id, subscription_id, slot_id, status, qr_token_hash, qr_expires_at) VALUES (?, ?, ?, ?, 'confirmed', ?, ?)`,
      [input.user_id, input.gym_id, input.subscription_id || null, input.slot_id || null, tokenHash, expiresAt]);
    res.status(201).json({ id: ins.insertId, qr_token: token, qr_expires_at: expiresAt });
  } catch (e) { next(e); }
});

module.exports = router;
