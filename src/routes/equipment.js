// src/routes/equipment.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { body, query, param, validationResult } = require('express-validator');
const { publishSafe } = require('../mq')  // <-- usa publishSafe

/** helper */
const asyncH = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ok = (res, data, meta) => res.json({ data, meta });
const bad = (res, errors, code = 400) => res.status(code).json({ errors });

function normalizeRow(row) {
  const out = {};
  for (const k of Object.keys(row)) {
    const v = row[k];
    out[k] = Buffer.isBuffer(v) ? v.toString() : v;
  }
  return out;
}

/* ----------------------------------
 * CATEGORIES
 * ----------------------------------*/

// GET /equipment/categories?search=&parent_id=&limit=&offset=
router.get('/categories',
  [
    query('limit').optional().isInt({ min: 1, max: 200 }),
    query('offset').optional().isInt({ min: 0 }),
  ],
  asyncH(async (req, res) => {
    const { search, parent_id, limit = 100, offset = 0, gym_id } = req.query;
    const wh = [];
    const pr = [];
    if (search) { wh.push('name LIKE ?'); pr.push(`%${search}%`); }
    if (parent_id) { wh.push('parent_id = ?'); pr.push(parent_id); }
    if (gym_id) { wh.push('gym_id = ?'); pr.push(gym_id); }
    const where = wh.length ? `WHERE ${wh.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT id, name, parent_id, created_at, updated_at
       FROM equipment_categories ${where}
       ORDER BY name ASC
       LIMIT ? OFFSET ?`, [...pr, Number(limit), Number(offset)]
    );

    const data = rows.map(r => normalizeRow(r));

    ok(res, data, { limit: Number(limit), offset: Number(offset) });
  })
);

// POST /equipment/categories
router.post('/categories',
  [ body('name').isString().isLength({ min: 2, max: 80 }) ],
  asyncH(async (req, res) => {
    const v = validationResult(req); if (!v.isEmpty()) return bad(res, v.array());
    const { name, parent_id = null, gym_id } = req.body;
    const [r] = await pool.query(
      `INSERT INTO equipment_categories (name, parent_id, created_at, updated_at, gym_id)
       VALUES (?, ?, NOW(), NOW(), ?)`,
      [name, parent_id, gym_id]
    );

const [[created]] = await pool.query(
      `SELECT * FROM equipment_categories WHERE id=?`,
      [r.insertId]
    );

    // Preparo payload
    const payload = {
      action: 'create',
      entity: 'equipment_category',
      data: created,
      gym_id: gym_id
    };

    // Publish su exchange "equipment"
    publishSafe('equipment', 'categories.create.*', payload)
      .catch(err => console.error('[publish category create]', err.message));

    res.status(201).json({ data: created });
  })
);

// PATCH /equipment/categories/:id
router.patch('/categories/:id',
  [ param('id').isInt() ],
  asyncH(async (req, res) => {
    const { id } = req.params;
    const { name, parent_id } = req.body;
    const sets = []; const pr = [];
    if (name !== undefined) { sets.push('name=?'); pr.push(name); }
    if (parent_id !== undefined) { sets.push('parent_id=?'); pr.push(parent_id); }
    if (!sets.length) return bad(res, [{ msg: 'Nothing to update' }]);
    pr.push(id);
    await pool.query(`UPDATE equipment_categories SET ${sets.join(', ')}, updated_at=NOW() WHERE id=?`, pr);
    const [[updated]] = await pool.query(
      `SELECT * FROM equipment_categories WHERE id=?`,
      [id]
    );

    // Publish RabbitMQ
    const payload = {
      action: 'update',
      entity: 'equipment_category',
      data: updated
    };

    // fire-and-forget (se preferisci bloccare in caso di errore, usa await)
    publishSafe('equipment', 'categories.update.*', payload)
      .catch(err => console.error('[publish category update]', err.message));
    ok(res, updated);
  })
);

// DELETE /equipment/categories/:id
router.delete('/categories/:id',
  [ param('id').isInt() ],
  asyncH(async (req, res) => {
    const { id } = req.params;
    await pool.query(`DELETE FROM equipment_categories WHERE id=?`, [id]);

        const [[toDelete]] = await pool.query(
      `SELECT * FROM equipment_categories WHERE id=?`,
      [id]
    );

    const payload = {
      action: 'delete',
      entity: 'equipment_category',
      data: toDelete
    };

    // Publish RabbitMQ (fire-and-forget)
    publishSafe('equipment', 'categories.delete.*', payload)
      .catch(err => console.error('[publish category delete]', err.message));

    res.status(204).send();
  })
);

/* ----------------------------------
 * MODELS + SPECS
 * ----------------------------------*/

// GET /equipment/models?category_id=&is_track_per_item=&search=&limit=&offset=
router.get('/models',
  [
    query('limit').optional().isInt({ min: 1, max: 200 }),
    query('offset').optional().isInt({ min: 0 }),
  ],
  asyncH(async (req, res) => {
    const { category_id, is_track_per_item, search, limit = 50, offset = 0, gym_id } = req.query;
    const wh = []; const pr = [];
    if (category_id) { wh.push('m.category_id = ?'); pr.push(category_id); }
    if (is_track_per_item !== undefined) { wh.push('m.is_track_per_item = ?'); pr.push(is_track_per_item ? 1 : 0); }
    if (search) { wh.push('(m.model_name LIKE ? OR m.brand LIKE ? OR m.sku LIKE ?)'); pr.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    if (gym_id) { wh.push('m.gym_id = ?'); pr.push(gym_id); }
    const where = wh.length ? `WHERE ${wh.join(' AND ')}` : '';
    const [rows] = await pool.query(
  `SELECT
     m.id, m.category_id, m.brand, m.model_name, m.sku, m.description, m.photo_url,
     m.is_track_per_item, m.created_at, m.updated_at,
     c.name AS category_name
   FROM equipment_models m
   JOIN equipment_categories c ON c.id = m.category_id
   ${where}
   ORDER BY m.model_name ASC
   LIMIT ? OFFSET ?`, [...pr, Number(limit), Number(offset)]
);

const data = rows.map(r => normalizeRow(r));

    ok(res, data, { limit: Number(limit), offset: Number(offset) });
  })
);

// POST /equipment/models  (opzionale: specs[])
router.post('/models',
  [
    body('category_id').isInt(),
    body('model_name').isString().isLength({ min: 2, max: 180 }),
    body('is_track_per_item').optional().isBoolean()
  ],
  asyncH(async (req, res) => {
    const v = validationResult(req); if (!v.isEmpty()) return bad(res, v.array());
    const {
      category_id, brand = null, model_name, sku = null, description = null, photo_url = null,
      is_track_per_item = true, specs = [], gym_id
    } = req.body;

    // transazione (assume db.query gestisce connessione/pool; altrimenti usa getConnection)
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [r] = await conn.query(
        `INSERT INTO equipment_models
         (category_id, brand, model_name, sku, description, photo_url, is_track_per_item, created_at, updated_at, gym_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?)`,
        [category_id, brand, model_name, sku, description, photo_url, is_track_per_item ? 1 : 0, gym_id]
      );
      const modelId = r.insertId;

      if (Array.isArray(specs) && specs.length) {
        const rows = specs
          .filter(s => s && s.spec_key && s.spec_value)
          .map(s => [modelId, s.spec_key, s.spec_value]);
        if (rows.length) {
          await conn.query(
            `INSERT INTO equipment_model_specs (model_id, spec_key, spec_value, created_at, updated_at)
             VALUES ${rows.map(() => '(?,?,?,NOW(),NOW())').join(',')}`,
            rows.flat()
          );
        }
      }

      await conn.commit();
      const created = await pool.query(`SELECT * FROM equipment_models WHERE id=?`, [modelId]);


      const [[model]] = await pool.query(`
        SELECT em.*, ec.name AS category_name, ec.parent_id AS category_parent_id
        FROM equipment_models em
        LEFT JOIN equipment_categories ec ON ec.id = em.category_id
        WHERE em.id = ?`, [modelId]);

      const [specRows] = await pool.query(`
        SELECT spec_key, spec_value
        FROM equipment_model_specs
        WHERE model_id = ?`, [modelId]);

      const payload = {
        action: 'create',
        entity: 'equipment_model',
        data: {
          ...model,
          specs: specRows
        }
      };

     await publishSafe('equipment', 'equipment.create.model', payload).catch(err => console.error('[publish equipment]', err.message));

      res.status(201).json({ data: created[0] });
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  })
);

// PATCH /equipment/models/:id
router.patch('/models/:id',
  [ param('id').isInt() ],
  asyncH(async (req, res) => {
    const { id } = req.params;
    const allowed = ['category_id','brand','model_name','sku','description','photo_url','is_track_per_item'];
    const sets = []; const pr = [];
    for (const k of allowed) {
      if (req.body[k] !== undefined) {
        sets.push(`${k}=?`);
        pr.push(k === 'is_track_per_item' ? (req.body[k] ? 1 : 0) : req.body[k]);
      }
    }
    if (!sets.length) return bad(res, [{ msg: 'Nothing to update' }]);
    pr.push(id);
    await pool.query(`UPDATE equipment_models SET ${sets.join(', ')}, updated_at=NOW() WHERE id=?`, pr);
    const row = await pool.query(`SELECT * FROM equipment_models WHERE id=?`, [id]);

        const [[model]] = await pool.query(`
      SELECT em.*, ec.name AS category_name, ec.parent_id AS category_parent_id
      FROM equipment_models em
      LEFT JOIN equipment_categories ec ON ec.id = em.category_id
      WHERE em.id = ?`, [id]);

    const [specRows] = await pool.query(`
      SELECT spec_key, spec_value
      FROM equipment_model_specs
      WHERE model_id = ?`, [id]);

    const payload = {
      action: 'update',
      entity: 'equipment_model',
      data: { ...model, specs: specRows }
    };

    // Publish su RabbitMQ
    publishSafe('equipment', 'equipment.update.model', payload)
      .catch(err => console.error('[publish equipment update]', err.message));

    ok(res, row[0]);
  })
);

// DELETE /equipment/models/:id
router.delete('/models/:id',
  [ param('id').isInt() ],
  asyncH(async (req, res) => {
    const { id } = req.params;
    await pool.query(`DELETE FROM equipment_models WHERE id=?`, [id]);
    res.status(204).send();
  })
);

// GET /equipment/models/:id/specs
router.get('/models/:id/specs',
  [ param('id').isInt() ],
  asyncH(async (req, res) => {
    const { id } = req.params;
    const rows = await pool.query(
      `SELECT id, model_id, spec_key, spec_value, created_at, updated_at
       FROM equipment_model_specs WHERE model_id=? ORDER BY spec_key ASC`, [id]
    );
    ok(res, rows);
  })
);

// PUT /equipment/models/:id/specs (upsert full replace)
router.put('/models/:id/specs',
  [ param('id').isInt() ],
  asyncH(async (req, res) => {
    const { id } = req.params;
    const specs = Array.isArray(req.body) ? req.body : [];
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`DELETE FROM equipment_model_specs WHERE model_id=?`, [id]);
      if (specs.length) {
        const rows = specs.filter(s => s.spec_key && s.spec_value).map(s => [id, s.spec_key, s.spec_value, gym_id]);
        await conn.query(
          `INSERT INTO equipment_model_specs (model_id, spec_key, spec_value, created_at, updated_at, gym_id)
           VALUES ${rows.map(() => '(?,?,?,NOW(),NOW(),?)').join(',')}`,
          rows.flat()
        );
      }
      await conn.commit();
      const out = await pool.query(`SELECT * FROM equipment_model_specs WHERE model_id=?`, [id]);

            const [[model]] = await pool.query(`
        SELECT em.*, ec.name AS category_name, ec.parent_id AS category_parent_id
        FROM equipment_models em
        LEFT JOIN equipment_categories ec ON ec.id = em.category_id
        WHERE em.id = ?`, [id]);

      const [specRows] = await pool.query(`
        SELECT spec_key, spec_value
        FROM equipment_model_specs
        WHERE model_id = ?`, [id]);

      const payload = {
        action: 'update',
        entity: 'equipment_model_specs',
        data: { ...model, specs: specRows }
      };

      // Publish (fire-and-forget, log error ma non blocca la risposta)
      publishSafe('equipment', 'equipment.update.specs', payload)
        .catch(err => console.error('[publish specs update]', err.message));

      ok(res, out);
    } catch (e) {
      await conn.rollback(); throw e;
    } finally {
      conn.release();
    }
  })
);

/* ----------------------------------
 * ASSETS
 * ----------------------------------*/

// GET /equipment/assets?gym_id=1&location_id=&model_id=&status_enum=&q=&limit=&offset=
router.get('/assets',
  [
    query('gym_id').isInt(),
    query('limit').optional().isInt({ min: 1, max: 200 }),
    query('offset').optional().isInt({ min: 0 }),
  ],
  asyncH(async (req, res) => {
    const { gym_id, location_id, model_id, status_enum, q, limit = 50, offset = 0 } = req.query;
    const wh = ['a.gym_id = ?']; const pr = [gym_id];
    if (location_id) { wh.push('a.location_id = ?'); pr.push(location_id); }
    if (model_id) { wh.push('a.model_id = ?'); pr.push(model_id); }
    if (status_enum) { wh.push('a.status_enum = ?'); pr.push(status_enum); }
    if (q) { wh.push('(a.tag_code LIKE ? OR a.serial_number LIKE ? OR m.model_name LIKE ? OR m.brand LIKE ?)'); pr.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }

    const [rows] = await pool.query(
      `SELECT
  a.id, a.gym_id, a.location_id, a.model_id, a.tag_code, a.serial_number,
  a.purchase_date, a.purchase_price_cents, a.condition_enum, a.status_enum,
  a.notes, a.created_at, a.updated_at,
  m.brand, m.model_name, c.name AS category_name
FROM equipment_assets a
JOIN equipment_models m ON m.id = a.model_id
JOIN equipment_categories c ON c.id = m.category_id
WHERE ${wh.join(' AND ')}
ORDER BY a.updated_at DESC
LIMIT ? OFFSET ?`, [...pr, Number(limit), Number(offset)]
    );

const data = rows.map(r => normalizeRow(r));

    ok(res, data, { limit: Number(limit), offset: Number(offset) });
  })
);

// POST /equipment/assets
router.post('/assets',
  [
    body('gym_id').isInt(),
    body('model_id').isInt(),
    body('status_enum').optional().isIn(['active','maintenance','retired','lost']),
    body('condition_enum').optional().isIn(['new','good','worn','damaged','out_of_service']),
  ],
  asyncH(async (req, res) => {
    const v = validationResult(req); if (!v.isEmpty()) return bad(res, v.array());
    const {
      gym_id, location_id = null, model_id, tag_code = null, serial_number = null,
      purchase_date = null, purchase_price_cents = null,
      condition_enum = 'good', status_enum = 'active', notes = null
    } = req.body;

    const r = await pool.query(
      `INSERT INTO equipment_assets
       (gym_id, location_id, model_id, tag_code, serial_number, purchase_date, purchase_price_cents,
        condition_enum, status_enum, notes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
      [gym_id, location_id, model_id, tag_code, serial_number, purchase_date, purchase_price_cents,
        condition_enum, status_enum, notes]
    );
    const created = await pool.query(`SELECT * FROM equipment_assets WHERE id=?`, [r.insertId]);
    res.status(201).json({ data: created[0] });
  })
);

// PATCH /equipment/assets/:id
router.patch('/assets/:id',
  [ param('id').isInt() ],
  asyncH(async (req, res) => {
    const { id } = req.params;
    const allowed = ['gym_id','location_id','model_id','tag_code','serial_number','purchase_date','purchase_price_cents','condition_enum','status_enum','notes'];
    const sets = []; const pr = [];
    for (const k of allowed) if (req.body[k] !== undefined) { sets.push(`${k}=?`); pr.push(req.body[k]); }
    if (!sets.length) return bad(res, [{ msg: 'Nothing to update' }]);
    pr.push(id);
    await pool.query(`UPDATE equipment_assets SET ${sets.join(', ')}, updated_at=NOW() WHERE id=?`, pr);
    const row = await pool.query(`SELECT * FROM equipment_assets WHERE id=?`, [id]);
    ok(res, row[0]);
  })
);

// DELETE /equipment/assets/:id
router.delete('/assets/:id',
  [ param('id').isInt() ],
  asyncH(async (req, res) => {
    await pool.query(`DELETE FROM equipment_assets WHERE id=?`, [req.params.id]);
    res.status(204).send();
  })
);

/* ----------------------------------
 * STOCK + STOCK SPECS
 * ----------------------------------*/

// GET /equipment/stock?gym_id=1&location_id=&model_id=&q=&limit=&offset=
router.get('/stock',
  [
    query('gym_id').isInt(),
    query('limit').optional().isInt({ min: 1, max: 200 }),
    query('offset').optional().isInt({ min: 0 }),
  ],
  asyncH(async (req, res) => {
    const { gym_id, location_id, model_id, q, limit = 100, offset = 0 } = req.query;
    const wh = ['s.gym_id=?']; const pr = [gym_id];
    if (location_id) { wh.push('s.location_id=?'); pr.push(location_id); }
    if (model_id) { wh.push('s.model_id=?'); pr.push(model_id); }
    if (q) { wh.push('(s.variant_label LIKE ? OR m.model_name LIKE ? OR m.brand LIKE ?)'); pr.push(`%${q}%`, `%${q}%`, `%${q}%`); }

    const [rows] = await pool.query(
      `SELECT
  s.id, s.gym_id, s.location_id, s.model_id, s.variant_label,
  s.quantity, s.min_quantity, s.created_at, s.updated_at,
  m.brand, m.model_name, c.name AS category_name
FROM equipment_stock s
JOIN equipment_models m ON m.id = s.model_id
JOIN equipment_categories c ON c.id = m.category_id
WHERE ${wh.join(' AND ')}
ORDER BY s.updated_at DESC
LIMIT ? OFFSET ?`, [...pr, Number(limit), Number(offset)]
    );

    const data = rows.map(r => normalizeRow(r));

    ok(res, data, { limit: Number(limit), offset: Number(offset) });
  })
);

// POST /equipment/stock
router.post('/stock',
  [
    body('gym_id').isInt(),
    body('model_id').isInt(),
    body('quantity').optional().isInt({ min: 0 }),
    body('min_quantity').optional().isInt({ min: 0 }),
  ],
  asyncH(async (req, res) => {
    const v = validationResult(req); if (!v.isEmpty()) return bad(res, v.array());
    const { gym_id, location_id = null, model_id, variant_label = null, quantity = 0, min_quantity = 0 } = req.body;
    const r = await pool.query(
      `INSERT INTO equipment_stock (gym_id, location_id, model_id, variant_label, quantity, min_quantity, created_at, updated_at)
       VALUES (?,?,?,?,?,?,NOW(),NOW())`,
      [gym_id, location_id, model_id, variant_label, quantity, min_quantity]
    );
    const row = await pool.query(`SELECT * FROM equipment_stock WHERE id=?`, [r.insertId]);
    res.status(201).json({ data: row[0] });
  })
);

// PATCH /equipment/stock/:id   (supporta incrementi atomici con quantity_delta)
router.patch('/stock/:id',
  [ param('id').isInt() ],
  asyncH(async (req, res) => {
    const { id } = req.params;
    const { quantity, min_quantity, quantity_delta, variant_label, location_id } = req.body;

    // increment atomico
    if (quantity_delta !== undefined) {
      await pool.query(`UPDATE equipment_stock SET quantity = GREATEST(0, quantity + ?), updated_at=NOW() WHERE id=?`, [Number(quantity_delta), id]);
    }

    const sets = []; const pr = [];
    if (quantity !== undefined) { sets.push('quantity=?'); pr.push(quantity); }
    if (min_quantity !== undefined) { sets.push('min_quantity=?'); pr.push(min_quantity); }
    if (variant_label !== undefined) { sets.push('variant_label=?'); pr.push(variant_label); }
    if (location_id !== undefined) { sets.push('location_id=?'); pr.push(location_id); }
    if (sets.length) {
      pr.push(id);
      await pool.query(`UPDATE equipment_stock SET ${sets.join(', ')}, updated_at=NOW() WHERE id=?`, pr);
    }
    const row = await pool.query(`SELECT * FROM equipment_stock WHERE id=?`, [id]);
    ok(res, row[0]);
  })
);

// DELETE /equipment/stock/:id
router.delete('/stock/:id',
  [ param('id').isInt() ],
  asyncH(async (req, res) => {
    await pool.query(`DELETE FROM equipment_stock WHERE id=?`, [req.params.id]);
    res.status(204).send();
  })
);

// GET /equipment/stock/:id/specs
router.get('/stock/:id/specs',
  [ param('id').isInt() ],
  asyncH(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT id, stock_id, spec_key, spec_value, created_at, updated_at
       FROM equipment_stock_specs WHERE stock_id=? ORDER BY spec_key ASC`, [req.params.id]
    );
    const data = rows.map(r => normalizeRow(r));
    ok(res, data);
  })
);

// PUT /equipment/stock/:id/specs  (upsert: replace-all)
router.put('/stock/:id/specs',
  [ param('id').isInt() ],
  asyncH(async (req, res) => {
    const stockId = req.params.id;
    const specs = Array.isArray(req.body) ? req.body : [];
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`DELETE FROM equipment_stock_specs WHERE stock_id=?`, [stockId]);
      if (specs.length) {
        const rows = specs.filter(s => s.spec_key && s.spec_value).map(s => [stockId, s.spec_key, s.spec_value]);
        await conn.query(
          `INSERT INTO equipment_stock_specs (stock_id, spec_key, spec_value, created_at, updated_at)
           VALUES ${rows.map(() => '(?,?,?,NOW(),NOW())').join(',')}`,
          rows.flat()
        );
      }
      await conn.commit();
      const out = await pool.query(`SELECT * FROM equipment_stock_specs WHERE stock_id=?`, [stockId]);
      ok(res, out);
    } catch (e) {
      await conn.rollback(); throw e;
    } finally {
      conn.release();
    }
  })
);

module.exports = router;
