// src/routes/course_types.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth'); // se già usi questo
const { pick, toSlug } = require('../util');

// router.use(requireAuth);

/**
 * GET /gyms/:gymId/course-types
 */
router.get('/:gymId/course-types', async (req, res, next) => {
  try {
    const { gymId } = req.params;
    const [rows] = await pool.query(
      `SELECT id, gym_id AS gymId, name, slug, duration_min AS durationMin, description, level, status,
              created_at AS createdAt, updated_at AS updatedAt
       FROM course_types
       WHERE gym_id = ? AND status IN ('active','inactive')
       ORDER BY name`, [gymId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/**
 * POST /gyms/:gymId/course-types
 * body: { name, durationMin, description?, level?, status? }
 */
router.post('/:gymId/course-types', async (req, res, next) => {
  try {
    const { gymId } = req.params;
    const body = pick(req.body, ['name','durationMin','description','level','status']);
    if (!body.name || !body.durationMin) return res.status(400).json({ message: 'name and durationMin are required' });

    const slug = toSlug(body.name);
    await pool.query(
      `INSERT INTO course_types (gym_id, name, slug, duration_min, description, level, status)
       VALUES (?,?,?,?,?,?,COALESCE(?, 'active'))`,
       [gymId, body.name, slug, body.durationMin, body.description || null, body.level || null, body.status]
    );

    const [row] = await pool.query(`SELECT * FROM course_types WHERE gym_id=? AND slug=?`, [gymId, slug]);
    res.status(201).json(row[0]);
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Course slug already exists' });
    next(err);
  }
});

/**
 * PATCH /course-types/:id
 */
router.patch('/course-types/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const body = pick(req.body, ['name','durationMin','description','level','status']);
    const fields = [];
    const values = [];

    if (body.name) { fields.push('name=?'); values.push(body.name); fields.push('slug=?'); values.push(toSlug(body.name)); }
    if (body.durationMin != null) { fields.push('duration_min=?'); values.push(body.durationMin); }
    if ('description' in body) { fields.push('description=?'); values.push(body.description); }
    if ('level' in body) { fields.push('level=?'); values.push(body.level); }
    if (body.status) { fields.push('status=?'); values.push(body.status); }

    if (!fields.length) return res.status(400).json({ message: 'No fields to update' });

    values.push(id);
    await pool.query(`UPDATE course_types SET ${fields.join(', ')} WHERE id=?`, values);

    const [rows] = await pool.query(
      `SELECT id, gym_id AS gymId, name, slug, duration_min AS durationMin, description, level, status
       FROM course_types WHERE id=?`, [id]);
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
