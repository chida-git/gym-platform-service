const router = require('express').Router();
const Joi = require('joi');
const { pool } = require('../db');
const { hashToken } = require('../util');

router.post('/verify', async (req, res, next) => {
  try {
    const schema = Joi.object({ qr_token: Joi.string().min(16).required(), verifier_device_id: Joi.string().optional() });
    const { qr_token, verifier_device_id } = await schema.validateAsync(req.body);
    const h = hashToken(qr_token);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query('SELECT * FROM bookings WHERE qr_token_hash = ? FOR UPDATE', [h]);
      if (rows.length === 0) { await conn.rollback(); return res.status(404).json({ error: 'Invalid token' }); }
      const b = rows[0];
      if (new Date(b.qr_expires_at) < new Date()) { await conn.rollback(); return res.status(410).json({ error: 'Token expired' }); }
      if (b.status === 'checked_in') { await conn.rollback(); return res.status(409).json({ error: 'Already used' }); }

      await conn.query('UPDATE bookings SET status="checked_in", checked_in_at = NOW() WHERE id=?', [b.id]);

      if (b.subscription_id) {
        const [[sub]] = await conn.query('SELECT id, entries_remaining FROM subscriptions WHERE id=? FOR UPDATE', [b.subscription_id]);
        if (sub && sub.entries_remaining !== null) {
          if (sub.entries_remaining <= 0) {
            await conn.rollback();
            return res.status(402).json({ error: 'No entries remaining' });
          }
          await conn.query('UPDATE subscriptions SET entries_remaining = entries_remaining - 1 WHERE id=?', [b.subscription_id]);
        }
      }

      await conn.query('INSERT INTO checkins (booking_id, subscription_id, verifier_device_id, source, used_at) VALUES (?, ?, ?, "qr", NOW())',
        [b.id, b.subscription_id || null, verifier_device_id || null]);

      await conn.commit();
      res.json({ ok: true, booking_id: b.id });
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  } catch (e) { next(e); }
});

module.exports = router;
