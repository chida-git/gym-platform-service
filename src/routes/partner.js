const router = require('express').Router();
const Joi = require('joi');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

// Protect all /partner routes
router.use(requireAuth);

// PATCH /partner/slots/:id
router.patch('/slots/:id', async (req, res, next) => {
  try {
    const id = +req.params.id;
    const schema = Joi.object({ is_active: Joi.number().valid(0,1).optional(), capacity: Joi.number().min(0).optional(), available: Joi.number().min(0).optional() }).min(1);
    const body = await schema.validateAsync(req.body);
    const fields = []; const params = [];
    for (const k of Object.keys(body)) { fields.push(`${k}=?`); params.push(body[k]); }
    params.push(id);
    const [r] = await pool.query(`UPDATE inventory_slots SET ${fields.join(', ')} WHERE id=?`, params);
    res.json({ affectedRows: r.affectedRows });
  } catch (e) { next(e); }
});

// GET /partner/slots?gym_id=&date=YYYY-MM-DD
router.get('/slots', async (req, res, next) => {
  try {
    const schema = Joi.object({ gym_id: Joi.number().required(), date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required() });
    const { gym_id, date } = await schema.validateAsync(req.query);
    if (req.partner.gym_id !== gym_id) return res.status(403).json({ error: 'Forbidden' });
    const [rows] = await pool.query(`SELECT id, date, time_from, time_to, capacity, available, is_active FROM inventory_slots WHERE gym_id=? AND date=? ORDER BY time_from ASC`, [gym_id, date]);
    res.json(rows);
  } catch (e) { next(e); }
});

// PATCH /partner/plans/:id
router.patch('/plans/:id', async (req, res, next) => {
  try {
    const id = +req.params.id;
    const schema = Joi.object({ price_cents: Joi.number().min(0).optional(), freeze_max_days: Joi.number().min(0).max(365).optional(), visible: Joi.number().valid(0,1).optional(), active: Joi.number().valid(0,1).optional() }).min(1);
    const body = await schema.validateAsync(req.body);
    const [[p]] = await pool.query('SELECT id, gym_id FROM plans WHERE id=?', [id]);
    if (!p) return res.status(404).json({ error: 'Plan not found' });
    if (p.gym_id !== req.partner.gym_id) return res.status(403).json({ error: 'Forbidden' });
    const fields = []; const params = [];
    for (const k of Object.keys(body)) { fields.push(`${k}=?`); params.push(body[k]); }
    params.push(id);
    const [r] = await pool.query(`UPDATE plans SET ${fields.join(', ')}, updated_at=NOW() WHERE id=?`, params);
    res.json({ affectedRows: r.affectedRows });
  } catch (e) { next(e); }
});

// POST /partner/plans
router.post('/plans', async (req, res, next) => {
  try {
    const schema = Joi.object({ gym_id: Joi.number().required(), name: Joi.string().max(180).required(), plan_type: Joi.string().valid('monthly','pack','daypass','trial','annual').required(), description: Joi.string().allow(null, '').optional(), price_cents: Joi.number().min(0).required(), currency: Joi.string().length(3).default('EUR'), duration_days: Joi.number().allow(null).optional(), entries_total: Joi.number().allow(null).optional(), access_per_day: Joi.number().allow(null).optional(), freeze_max_days: Joi.number().min(0).default(0), visible: Joi.number().valid(0,1).default(1), active: Joi.number().valid(0,1).default(1) });
    const input = await schema.validateAsync(req.body, { stripUnknown: true });
    if (input.gym_id !== req.partner.gym_id) return res.status(403).json({ error: 'Forbidden' });
    const [ins] = await pool.query(`INSERT INTO plans (gym_id, name, plan_type, description, price_cents, currency, duration_days, entries_total, access_per_day, freeze_max_days, visible, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`, [input.gym_id, input.name, input.plan_type, input.description || null, input.price_cents, input.currency, input.duration_days || null, input.entries_total || null, input.access_per_day || null, input.freeze_max_days, input.visible, input.active]);
    res.status(201).json({ id: ins.insertId });
  } catch (e) { next(e); }
});

// DELETE /partner/plans/:id
router.delete('/plans/:id', async (req, res, next) => {
  try {
    const id = +req.params.id;
    const [[p]] = await pool.query('SELECT id, gym_id FROM plans WHERE id=?', [id]);
    if (!p) return res.status(404).json({ error: 'Plan not found' });
    if (p.gym_id !== req.partner.gym_id) return res.status(403).json({ error: 'Forbidden' });
    const [r] = await pool.query('DELETE FROM plans WHERE id=?', [id]);
    res.json({ affectedRows: r.affectedRows });
  } catch (e) { next(e); }
});

// GET /partner/checkins?gym_id=&date=&q=
router.get('/checkins', async (req, res, next) => {
  try {
    const schema = Joi.object({ gym_id: Joi.number().required(), date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(), q: Joi.string().max(120).optional() });
    const { gym_id, date, q } = await schema.validateAsync(req.query);
    if (req.partner.gym_id !== gym_id) return res.status(403).json({ error: 'Forbidden' });
    const like = q ? `%${q}%` : null;
    const params = [gym_id, gym_id, date];
    let whereQ = '';
    if (like) { whereQ = ' AND (u.full_name LIKE ? OR u.email LIKE ?) '; params.push(like, like); }
    const sql = `SELECT c.id, c.used_at, b.status, u.full_name AS user_name, u.email AS user_email, p.name AS plan_name
                 FROM checkins c
                 LEFT JOIN bookings b ON b.id = c.booking_id
                 LEFT JOIN subscriptions s ON s.id = c.subscription_id
                 LEFT JOIN users u ON u.id = s.user_id
                 LEFT JOIN plans p ON p.id = s.plan_id
                 WHERE (b.gym_id = ? OR s.gym_id = ?) AND DATE(c.used_at) = ? ${whereQ}
                 ORDER BY c.used_at DESC LIMIT 500`;
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (e) { next(e); }
});

module.exports = router;
