// src/routes/weekly_slots.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { pick } = require('../util');

//router.use(requireAuth);

/**
 * GET /gyms/:gymId/weekly-slots
 */
router.get('/:gymId/weekly-slots', async (req, res, next) => {
  try {
    const { gymId } = req.params;
    const [rows] = await pool.query(
      `SELECT ws.id, ws.gym_id AS gymId, ws.course_type_id AS courseTypeId, ct.name AS courseName,
              ws.weekday, ws.start_time AS startTime, ws.duration_min AS durationMin,
              ws.capacity, ws.is_active AS isActive, ws.notes,
              ws.created_at AS createdAt, ws.updated_at AS updatedAt
       FROM weekly_slots ws
       JOIN course_types ct ON ct.id = ws.course_type_id
       WHERE ws.gym_id=? 
       ORDER BY ws.weekday, ws.start_time`, [gymId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/**
 * POST /gyms/:gymId/weekly-slots
 * body: { courseTypeId, weekday(0-6), startTime('HH:MM'), durationMin, capacity?, isActive? }
 */
router.post('/:gymId/weekly-slots', async (req, res, next) => {
  try {
    const { gymId } = req.params;
    const b = pick(req.body, ['courseTypeId','weekday','startTime','durationMin','capacity','isActive','notes']);
    if (b.courseTypeId == null || b.weekday == null || !b.startTime || !b.durationMin)
      return res.status(400).json({ message: 'courseTypeId, weekday, startTime, durationMin are required' });
    await pool.query(
      `INSERT INTO weekly_slots (gym_id, course_type_id, weekday, start_time, duration_min, capacity, is_active, notes)
       VALUES (?,?,?,?,?,?,COALESCE(?,1),?)`,
       [gymId, b.courseTypeId, b.weekday, b.startTime, b.durationMin, b.capacity || null, b.isActive, b.notes || null]
    );
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * PATCH /weekly-slots/:id
 */
router.patch('/weekly-slots/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const b = pick(req.body, ['courseTypeId','weekday','startTime','durationMin','capacity','isActive','notes']);
    const fields = [], values = [];
    if (b.courseTypeId != null) { fields.push('course_type_id=?'); values.push(b.courseTypeId); }
    if (b.weekday != null) { fields.push('weekday=?'); values.push(b.weekday); }
    if (b.startTime) { fields.push('start_time=?'); values.push(b.startTime); }
    if (b.durationMin != null) { fields.push('duration_min=?'); values.push(b.durationMin); }
    if ('capacity' in b) { fields.push('capacity=?'); values.push(b.capacity); }
    if ('isActive' in b) { fields.push('is_active=?'); values.push(b.isActive ? 1 : 0); }
    if ('notes' in b) { fields.push('notes=?'); values.push(b.notes); }
    if (!fields.length) return res.status(400).json({ message: 'No fields to update' });

    values.push(id);
    await pool.query(`UPDATE weekly_slots SET ${fields.join(', ')} WHERE id=?`, values);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * POST /weekly-slots/:id/overrides
 * body: { date: 'YYYY-MM-DD', cancelled?: true, startTime?, durationMin?, notes? }
 */
router.post('/weekly-slots/:id/overrides', async (req, res, next) => {
  try {
    const { id } = req.params;
    const b = pick(req.body, ['date','cancelled','startTime','durationMin','notes','gymId']);
    if (!b.date) return res.status(400).json({ message: 'date is required' });

    // infer gymId from slot to keep body simple
    let gymId = b.gymId;
    if (!gymId) {
      const [slot] = await pool.query(`SELECT gym_id FROM weekly_slots WHERE id=?`, [id]);
      if (!slot.length) return res.status(404).json({ message: 'weekly slot not found' });
      gymId = slot[0].gym_id;
    }

    await pool.query(
      `INSERT INTO class_overrides (gym_id, weekly_slot_id, override_date, cancelled, start_time, duration_min, notes)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE cancelled=VALUES(cancelled),
                               start_time=VALUES(start_time),
                               duration_min=VALUES(duration_min),
                               notes=VALUES(notes)`,
      [gymId, id, b.date, b.cancelled ? 1 : 0, b.startTime || null, b.durationMin || null, b.notes || null]
    );
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
