// src/routes/gym_extras.js
const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { publishSafe } = require('../mq')  // <-- usa publishSafe

const ok = (res, data, status = 200) => res.status(status).json({ data });
const bad = (res, msg = "Bad Request", status = 400) =>
  res.status(status).json({ error: msg });

// Lista extras di una palestra
router.get("/:gymId/extras", async (req, res, next) => {
  const gymId = Number(req.params.gymId);
  if (!gymId) return bad(res, "gymId non valido");
  try {
    const [rows] = await pool.query(
      `SELECT e.id, e.name, e.description
       FROM gym_extras ge
       JOIN extras e ON e.id = ge.extra_id
       WHERE ge.gym_id = ?
       ORDER BY e.name`,
      [gymId]
    );
    ok(res, rows);
  } catch (e) { next(e); }
});

// Aggancia uno o più extra (idempotente)
router.post("/:gymId/extras", async (req, res, next) => {
  console.log("ok")
  const gymId = Number(req.params.gymId);
  const { extraIds } = req.body || {};
  if (!gymId) return bad(res, "gymId non valido");
  if (!Array.isArray(extraIds) || extraIds.length === 0) return bad(res, "extraIds[] richiesto");

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const extraId of extraIds) {
      await conn.query(
        "INSERT IGNORE INTO gym_extras (gym_id, extra_id) VALUES (?, ?)",
        [gymId, Number(extraId)]
      );
    }
    await conn.commit();
    const [rows] = await pool.query(
      `SELECT e.id, e.name, e.description
       FROM gym_extras ge JOIN extras e ON e.id = ge.extra_id
       WHERE ge.gym_id = ? ORDER BY e.name`, [gymId]
    );
    console.log(".1")
    for (const extraId of extraIds) {
      console.log("extraId", extraId)
      const row = await pool.query(
      `SELECT e.id, e.name, e.description
       FROM gym_extras ge JOIN extras e ON e.id = ge.extra_id
       WHERE ge.gym_id = ? AND extra_id = ? ORDER BY e.name`, [gymId, Number(extraId)]
    );

    publishSafe('halls', `extra.add.*`, { id: row.id, gym_id: row.gym_id, extra_id: row.extra_id }).catch(()=>{})
    }
        ok(res, rows, 201);
  } catch (e) {
    await conn.rollback();
    next(e);
  } finally {
    conn.release();
  }
});

// Sostituisce l’elenco (PUT)
router.put("/:gymId/extras", async (req, res, next) => {
  const gymId = Number(req.params.gymId);
  const { extraIds } = req.body || {};
  if (!gymId) return bad(res, "gymId non valido");
  if (!Array.isArray(extraIds)) return bad(res, "extraIds[] richiesto (può essere vuoto)");

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("DELETE FROM gym_extras WHERE gym_id = ?", [gymId]);
    if (extraIds.length) {
      const values = extraIds.map(id => [gymId, Number(id)]);
      await conn.query(
        "INSERT INTO gym_extras (gym_id, extra_id) VALUES ?",
        [values]
      );
    }
    await conn.commit();
    const [rows] = await pool.query(
      `SELECT e.id, e.name, e.description
       FROM gym_extras ge JOIN extras e ON e.id = ge.extra_id
       WHERE ge.gym_id = ? ORDER BY e.name`, [gymId]
    );
    ok(res, rows);
  } catch (e) {
    await conn.rollback();
    next(e);
  } finally {
    conn.release();
  }
});

// Rimuove singolo extra
router.delete("/:gymId/extras/:extraId", async (req, res, next) => {
  const gymId = Number(req.params.gymId);
  const extraId = Number(req.params.extraId);
  if (!gymId || !extraId) return bad(res, "parametri non validi");
  try {
    const [r] = await pool.query(
      "DELETE FROM gym_extras WHERE gym_id = ? AND extra_id = ?",
      [gymId, extraId]
    );
    if (r.affectedRows === 0) return bad(res, "associazione non trovata", 404);
    ok(res, { gymId, extraId });
  } catch (e) { next(e); }
});

module.exports=router;
