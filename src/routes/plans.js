const router = require('express').Router();
const { pool } = require('../db');

router.get('/', async (req, res, next) => {
  try {
    const gymId = +req.query.gym_id;
    if (!gymId) return res.status(400).json({ error: 'gym_id required' });
    const [rows] = await pool.query(
      `SELECT id, name, plan_type, description, price_cents, currency,
              duration_days, entries_total, access_per_day, freeze_max_days
       FROM plans WHERE gym_id = ? AND active = 1 AND visible = 1
       ORDER BY price_cents ASC`, [gymId]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

module.exports = router;