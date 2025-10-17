// routes/gymRoutes.js
import express from 'express';
import { pool } from '../db.js'; // pool mysql2/promise

const router = express.Router();

/**
 * GET /api/gyms/:id_gym/routes
 * Ritorna la configurazione effettiva { overview: true, ... }
 */
router.get('/gyms/:id_gym/routes', async (req, res) => {
  const { id_gym } = req.params;
  const [rows] = await pool.query(
    `SELECT route_key, enabled
     FROM v_gym_routes_effective
     WHERE gym_id = ?`,
    [id_gym]
  );

  // In mancanza della vista, puoi farlo con una LEFT JOIN ‘manuale’ a runtime.
  const map = {};
  rows.forEach(r => { map[r.route_key] = !!r.enabled; });
  res.json(map);
});

/**
 * PUT /api/gyms/:id_gym/routes
 * Body: { route_key: "plans", enabled: true }  // singolo update
 * oppure { updates: [{ route_key, enabled }, ...] } // batch
 */
router.put('/gyms/:id_gym/routes', async (req, res) => {
  const { id_gym } = req.params;
  const { route_key, enabled, updates } = req.body;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const doUpsert = async (rk, en) => {
      await conn.query(
        `INSERT INTO gym_route_config (gym_id, route_key, enabled)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)`,
        [id_gym, rk, en ? 1 : 0]
      );
    };

    if (Array.isArray(updates)) {
      for (const u of updates) {
        await doUpsert(u.route_key, u.enabled);
      }
    } else {
      await doUpsert(route_key, enabled);
    }

    await conn.commit();
    res.status(204).end();
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

/**
 * DELETE /api/gyms/:id_gym/routes/:route_key
 * Rimuove l’override (torna al default)
 */
router.delete('/gyms/:id_gym/routes/:route_key', async (req, res) => {
  const { id_gym, route_key } = req.params;
  await pool.query(
    `DELETE FROM gym_route_config WHERE gym_id = ? AND route_key = ?`,
    [id_gym, route_key]
  );
  res.status(204).end();
});

export default router;
