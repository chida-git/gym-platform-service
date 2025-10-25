// src/routes/gym_extras.js
const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { publishSafe } = require('../mq')  // <-- usa publishSafe

// helper per risposte
const ok = (res, data, status = 200) => res.status(status).json({ data });
const bad = (res, msg = "Bad Request", status = 400) =>
  res.status(status).json({ error: msg });

// LIST
router.get("/", async (_req, res, next) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, name, description, created_at, updated_at FROM extras ORDER BY name"
    );
    ok(res, rows);
  } catch (e) { next(e); }
});

// CREATE
router.post("/", async (req, res, next) => {
  const { name, description = null } = req.body || {};
  if (!name || typeof name !== "string") return bad(res, "name richiesto");
  try {
    const [r] = await pool.query(
      "INSERT INTO extras (name, description) VALUES (?, ?)",
      [name.trim(), description]
    );
    const [rows] = await pool.query("SELECT * FROM extras WHERE id = ?", [r.insertId]);
    publishSafe('halls', `extra.global.*`, { name: name.trim(), description: description }).catch(()=>{})
    ok(res, rows[0], 201);
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") return bad(res, "name già esistente", 409);
    next(e);
  }
});

// UPDATE
router.put("/:id", async (req, res, next) => {
  const id = Number(req.params.id);
  const { name, description } = req.body || {};
  if (!id) return bad(res, "id non valido");
  if (!name && typeof description === "undefined") return bad(res, "niente da aggiornare");
  const fields = [];
  const vals = [];
  if (name) { fields.push("name = ?"); vals.push(name.trim()); }
  if (typeof description !== "undefined") { fields.push("description = ?"); vals.push(description); }
  vals.push(id);
  try {
    const [r] = await pool.query(
      `UPDATE extras SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      vals
    );
    if (r.affectedRows === 0) return bad(res, "extra non trovato", 404);
    const [rows] = await pool.query("SELECT * FROM extras WHERE id = ?", [id]);
    ok(res, rows[0]);
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") return bad(res, "name già in uso", 409);
    next(e);
  }
});

// DELETE
router.delete("/:id", async (req, res, next) => {
  const id = Number(req.params.id);
  if (!id) return bad(res, "id non valido");
  try {
    const [r] = await pool.query("DELETE FROM extras WHERE id = ?", [id]);
    if (r.affectedRows === 0) return bad(res, "extra non trovato", 404);
    ok(res, { deleted: id });
  } catch (e) { next(e); }
});

module.exports=router;
