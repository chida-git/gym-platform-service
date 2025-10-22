// src/routes/users.js
const express = require('express');
const { body, query, param } = require('express-validator');
const router = express.Router();
const { pool } = require('../db');

const asyncH = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/users',
  [
    query('gym_id').isInt().toInt(),
    query('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
    query('offset').optional().isInt({ min: 0 }).toInt(),
    query('search').optional().isString().trim(),
  ],
  asyncH(async (req, res) => {
    const { gym_id, limit = 50, offset = 0, search } = req.query;
    const wh = ['u.gym_id = ?'];
    const pr = [gym_id];
    if (search) {
      wh.push('(u.full_name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)');
      pr.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const [rows] = await pool.query(
      `SELECT u.* FROM users u WHERE ${wh.join(' AND ')} ORDER BY u.id DESC LIMIT ? OFFSET ?`,
      [...pr, Number(limit), Number(offset)]
    );
    res.json(rows);
  })
);

router.post('/users',
  [
    body('gym_id').isInt().toInt(),
    body('full_name').isString().trim().isLength({ min: 1, max: 180 }),
    body('email').isEmail().trim().isLength({ max: 180 }),
    body('phone').optional().isString().trim().isLength({ max: 40 }),
    body('status').optional().isIn(['active','inactive','banned'])
  ],
  asyncH(async (req, res) => {
    const { gym_id, full_name, email, phone = null, status = 'active' } = req.body;
    const [r] = await pool.query(
      `INSERT INTO users (gym_id, full_name, email, phone, status, created_at) 
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [gym_id, full_name, email, phone, status]
    );
    res.status(201).json({ id: r.insertId });
  })
);

// Bulk import/upsert by email within same gym
router.post('/users/bulk',
  [
    body('gym_id').isInt().toInt(),
    body('items').isArray({ min: 1 }),
    body('items.*.full_name').isString().trim(),
    body('items.*.email').isEmail().trim(),
    body('items.*.phone').optional().isString().trim(),
    body('items.*.status').optional().isIn(['active','inactive','banned'])
  ],
  asyncH(async (req, res) => {
    const { gym_id, items } = req.body;
    const values = items.map(i => [
      gym_id, i.full_name, i.email, i.phone || null, i.status || 'active'
    ]);
    // Create a temp table to perform upsert by (gym_id,email)
    await pool.query(`CREATE TEMPORARY TABLE tmp_users LIKE users`);
    if (values.length) {
      await pool.query(
        `INSERT INTO tmp_users (gym_id, full_name, email, phone, status, created_at)
         VALUES ?`, [values.map(v => [...v, new Date()])]
      );
      await pool.query(
        `INSERT INTO users (gym_id, full_name, email, phone, status, created_at)
         SELECT gym_id, full_name, email, phone, status, created_at FROM tmp_users
         ON DUPLICATE KEY UPDATE
           full_name = VALUES(full_name),
           phone = VALUES(phone),
           status = VALUES(status),
           updated_at = NOW()`
      );
    }
    res.json({ imported: values.length });
  })
);

router.patch('/users/:id',
  [
    param('id').isInt().toInt(),
    body('full_name').optional().isString().trim(),
    body('phone').optional().isString().trim(),
    body('status').optional().isIn(['active','inactive','banned'])
  ],
  asyncH(async (req, res) => {
    const { id } = req.params;
    const fields = []; const pr = [];
    ['full_name','phone','status'].forEach(k => {
      if (k in req.body) { fields.push(`${k} = ?`); pr.push(req.body[k]); }
    });
    if (!fields.length) return res.json({ updated: 0 });
    await pool.query(`UPDATE users SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`, [...pr, id]);
    res.json({ updated: 1 });
  })
);

module.exports = router;
