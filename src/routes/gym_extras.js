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
  // prepara gli eventi DOPO la commit: recupera l'id di mapping per ogni extra_id
    for (const raw of extraIds) {
      const extraId = Number(raw);
      if (!Number.isFinite(extraId) || extraId <= 0) continue;
      const [rowsId] = await pool.query(
        'SELECT id FROM gym_extras WHERE gym_id = ? AND extra_id = ? LIMIT 1',
        [gymId, extraId]
      );
      const id = rowsId?.[0]?.id || null;
      toPublish.push({ id, gym_id: gymId, extra_id: extraId });
    }

    // risposta: elenco extras aggiornato (includo anche extra_id se ti serve)
    const [rows] = await pool.query(
      `SELECT ge.id      AS gym_extra_id,
              ge.extra_id,
              e.name,
              e.description
         FROM gym_extras ge
         JOIN extras e ON e.id = ge.extra_id
        WHERE ge.gym_id = ?
        ORDER BY e.name`,
      [gymId]
    );

    ok(res, rows, 201);
  } catch (e) {
    await conn.rollback();
    next(e);
  } finally {
    conn.release();
  }
});

// Sostituisce l’elenco (PUT)
router.put('/:gymId/extras', async (req, res, next) => {
  const gymId = Number(req.params.gymId);
  const { extraIds } = req.body || {};
  if (!Number.isFinite(gymId) || gymId <= 0) return bad(res, 'gymId non valido');
  if (!Array.isArray(extraIds)) return bad(res, 'extraIds[] richiesto (può essere vuoto)');

  const conn = await pool.getConnection();
  const toPublish = [];

  try {
    await conn.beginTransaction();

    // reset
    await conn.query('DELETE FROM gym_extras WHERE gym_id = ?', [gymId]);

    // re-insert (con created_at)
    if (extraIds.length) {
      const values = [];
      const placeholders = [];
      for (const raw of extraIds) {
        const extraId = Number(raw);
        if (!Number.isFinite(extraId) || extraId <= 0) continue;
        placeholders.push('(?, ?, NOW())');
        values.push(gymId, extraId);
      }
      if (placeholders.length) {
        await conn.query(
          `INSERT INTO gym_extras (gym_id, extra_id, created_at) VALUES ${placeholders.join(',')}`,
          values
        );
      }
    }

    await conn.commit();

    // prepara gli eventi DOPO la commit: recupera l'id di mapping per ogni extra_id
    for (const raw of extraIds) {
      const extraId = Number(raw);
      if (!Number.isFinite(extraId) || extraId <= 0) continue;
      const [rowsId] = await pool.query(
        'SELECT id FROM gym_extras WHERE gym_id = ? AND extra_id = ? LIMIT 1',
        [gymId, extraId]
      );
      const id = rowsId?.[0]?.id || null;
      toPublish.push({ id, gym_id: gymId, extra_id: extraId });
    }

    // risposta: elenco extras aggiornato (includo anche extra_id se ti serve)
    const [rows] = await pool.query(
      `SELECT ge.id      AS gym_extra_id,
              ge.extra_id,
              e.name,
              e.description
         FROM gym_extras ge
         JOIN extras e ON e.id = ge.extra_id
        WHERE ge.gym_id = ?
        ORDER BY e.name`,
      [gymId]
    );

    // pubblica eventi (best-effort, non bloccare la risposta)
    Promise.allSettled(
      toPublish.map(m => publishSafe('halls', 'extra.add.v1', m))
    ).catch(() => {});

    ok(res, rows);
  } catch (e) {
    try { await conn.rollback(); } catch {}
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
