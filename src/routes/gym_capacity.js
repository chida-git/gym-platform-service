const express = require('express');
const { body, query } = require('express-validator');
const router = express.Router();
const { pool } = require('../db');
const asyncH = require('../middleware/async-handler');
const { ok } = require('../util');

// -------- GET CONFIG --------
router.get('/config', asyncH(async (req, res) => {
  const { gym_id } = req.query;
  const [rows] = await pool.query(
    `SELECT * FROM gym_capacity_config WHERE gym_id = ?`,
    [gym_id]
  );
  ok(res, rows[0] || null);
}));

// -------- UPDATE CONFIG --------
router.patch('/config/:gym_id', [
  body('max_capacity').isInt({ min: 0 }),
  body('note').optional().isString()
], asyncH(async (req, res) => {
  const { gym_id } = req.params;
  const { max_capacity, note } = req.body;
  await pool.query(
    `INSERT INTO gym_capacity_config (gym_id, max_capacity, note)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE max_capacity = VALUES(max_capacity), note = VALUES(note), updated_at = NOW()`,
    [gym_id, max_capacity, note]
  );
  ok(res, { gym_id, max_capacity, note });
}));

// -------- GET HALLS --------
router.get('/halls', asyncH(async (req, res) => {
  const { gym_id } = req.query;
  const [rows] = await pool.query(
    `SELECT id, name, max_capacity, description, created_at, updated_at
     FROM gym_halls WHERE gym_id = ? ORDER BY name ASC`,
    [gym_id]
  );
  ok(res, rows);
}));

// -------- CREATE HALL --------
router.post('/halls', [
  body('gym_id').isInt({ min: 1 }),
  body('name').isString().notEmpty(),
  body('max_capacity').isInt({ min: 0 }),
  body('description').optional().isString()
], asyncH(async (req, res) => {
  const { gym_id, name, max_capacity, description } = req.body;
  const [r] = await pool.query(
    `INSERT INTO gym_halls (gym_id, name, max_capacity, description)
     VALUES (?, ?, ?, ?)`,
    [gym_id, name, max_capacity, description || null]
  );
  ok(res, { id: r.insertId, gym_id, name, max_capacity, description });
}));

// -------- UPDATE HALL --------
router.patch('/halls/:id', [
  body('name').optional().isString(),
  body('max_capacity').optional().isInt({ min: 0 }),
  body('description').optional().isString()
], asyncH(async (req, res) => {
  const { id } = req.params;
  const { name, max_capacity, description } = req.body;
  await pool.query(
    `UPDATE gym_halls SET
       name = COALESCE(?, name),
       max_capacity = COALESCE(?, max_capacity),
       description = COALESCE(?, description),
       updated_at = NOW()
     WHERE id = ?`,
    [name, max_capacity, description, id]
  );
  ok(res, { id, name, max_capacity, description });
}));

// -------- DELETE HALL --------
router.delete('/halls/:id', asyncH(async (req, res) => {
  const { id } = req.params;
  await pool.query(`DELETE FROM gym_halls WHERE id = ?`, [id]);
  ok(res, { id });
}));

module.exports = router;
