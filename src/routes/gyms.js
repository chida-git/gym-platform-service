const router = require('express').Router();
const Joi = require('joi');
const { pool } = require('../db');
const multer = require('multer');
const path = require('path');
const { uploadBuffer, listByPrefix, deleteKey } = require('../s3');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 }, // 10MB, max 10 file
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(file.mimetype);
    cb(ok ? null : new Error('Formato non supportato (usa jpg/png/webp/avif)'), ok);
  }
});

router.post('/:gymId/presentation/images', upload.array('images', 10), async (req, res, next) => {
  try {
    const bucket = process.env.S3_BUCKET;
    const { gymId } = req.params;
    if (!/^\d+$/.test(gymId)) return res.status(400).json({ error: 'gymId non valido' });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'Nessun file caricato' });

    // "Creare la cartella": su S3 è un prefix. Caricando con quel Key, la "cartella" esiste.
    const prefix = `gyms/${gymId}/gym_presentation/`;

    const results = [];
    for (const f of req.files) {
      // mantieni il nome, o rinomina se vuoi forzare index/marker
      const safeName = f.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      const key = prefix + safeName;

      await uploadBuffer({
        Bucket: bucket,
        Key: key,
        Body: f.buffer,
        ContentType: f.mimetype,
        CacheControl: 'public, max-age=31536000, immutable'
      });

      const publicBase = process.env.S3_PUBLIC_BASE;
      results.push({
        key,
        url: publicBase ? `${publicBase}/${key}` : undefined,
        size: f.size,
        contentType: f.mimetype
      });
    }

    res.json({ ok: true, uploaded: results });
  } catch (e) {
    if (e.message && e.message.includes('Formato non supportato')) {
      return res.status(415).json({ error: e.message });
    }
    next(e);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const schema = Joi.object({ lat: Joi.number().optional(), lon: Joi.number().optional(), radius: Joi.number().default(2000), zone: Joi.string().optional() });
    const q = await schema.validateAsync(req.query);
    let sql = `SELECT gl.id as location_id, g.id as gym_id, g.name, gl.address_line1, gl.zone_label, gl.latitude, gl.longitude`;
    const params = [];
    const where = [];
    let order = ' ORDER BY g.name ASC';
    if (q.zone) { where.push('gl.zone_label = ?'); params.push(q.zone); }
    if (q.lat != null && q.lon != null) {
      const mode = (process.env.GEO_MODE || 'auto').toLowerCase();
      if (mode === 'haversine') {
        sql += `, (6371000 * ACOS(LEAST(1, COS(RADIANS(?)) * COS(RADIANS(gl.latitude)) * COS(RADIANS(gl.longitude) - RADIANS(?)) + SIN(RADIANS(?)) * SIN(RADIANS(gl.latitude))))) AS meters`;
        params.push(q.lat, q.lon, q.lat);
        where.push(' (6371000 * ACOS(LEAST(1, COS(RADIANS(?)) * COS(RADIANS(gl.latitude)) * COS(RADIANS(gl.longitude) - RADIANS(?)) + SIN(RADIANS(?)) * SIN(RADIANS(gl.latitude))))) <= ? ');
        params.push(q.lat, q.lon, q.lat, q.radius);
        order = ' ORDER BY meters ASC';
      } else {
        sql += `, ST_Distance_Sphere(gl.location, ST_SRID(POINT(?, ?), 4326)) AS meters`;
        params.push(q.lon, q.lat);
        where.push(' ST_Distance_Sphere(gl.location, ST_SRID(POINT(?, ?), 4326)) <= ? ');
        params.push(q.lon, q.lat, q.radius);
        order = ' ORDER BY meters ASC';
      }
    }
    const base = ` FROM gym_locations gl JOIN gyms g ON g.id = gl.gym_id `;
    const ws = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const finalSql = sql + base + ws + order + ' LIMIT 100';
    const [rows] = await pool.query(finalSql, params);
    res.json(rows);
  } catch (err) { next(err); }
});

// near
router.get('/near/:gymId', async (req, res, next) => {
  try {
    const gymId = +req.params.gymId;
    const radius = Math.max(100, Math.min(20000, +(req.query.radius || 2000)));
    const [[loc]] = await pool.query('SELECT latitude, longitude FROM gym_locations WHERE gym_id=? ORDER BY is_primary DESC, id ASC LIMIT 1', [gymId]);
    if (!loc) return res.status(404).json({ error: 'Gym location not found' });
    const lat = loc.latitude, lon = loc.longitude;
    let sql = `SELECT gl.id as location_id, g.id as gym_id, g.name, gl.address_line1, gl.zone_label, gl.latitude, gl.longitude`;
    const params = [];
    let order = ' ORDER BY g.name ASC';
    const mode = (process.env.GEO_MODE || 'auto').toLowerCase();
    if (mode === 'haversine') {
      sql += `, (6371000 * ACOS(LEAST(1, COS(RADIANS(?)) * COS(RADIANS(gl.latitude)) * COS(RADIANS(gl.longitude) - RADIANS(?)) + SIN(RADIANS(?)) * SIN(RADIANS(gl.latitude))))) AS meters`;
      params.push(lat, lon, lat);
      sql += ` FROM gym_locations gl JOIN gyms g ON g.id = gl.gym_id WHERE (6371000 * ACOS(LEAST(1, COS(RADIANS(?)) * COS(RADIANS(gl.latitude)) * COS(RADIANS(gl.longitude) - RADIANS(?)) + SIN(RADIANS(?)) * SIN(RADIANS(gl.latitude))))) <= ? ORDER BY meters ASC LIMIT 100`;
      params.push(lat, lon, lat, radius);
    } else {
      sql += `, ST_Distance_Sphere(gl.location, ST_SRID(POINT(?, ?), 4326)) AS meters`;
      params.push(lon, lat);
      sql += ` FROM gym_locations gl JOIN gyms g ON g.id = gl.gym_id WHERE ST_Distance_Sphere(gl.location, ST_SRID(POINT(?, ?), 4326)) <= ? ORDER BY meters ASC LIMIT 100`;
      params.push(lon, lat, radius);
    }
    const [rows] = await pool.query(sql, params);
    res.json({ origin: { gym_id: gymId, lat, lon, radius }, results: rows });
  } catch (e) { next(e); }
});

// get by id
router.get('/:id', async (req, res, next) => {
  try {
    const id = +req.params.id;
    const [[gym]] = await pool.query('SELECT id, name, vat_number, email, phone, status, created_at, updated_at FROM gyms WHERE id=?', [id]);
    if (!gym) return res.status(404).json({ error: 'Gym not found' });
    const [locations] = await pool.query('SELECT id, address_line1, address_line2, city, province, postal_code, zone_label, latitude, longitude, is_primary, opening_hours FROM gym_locations WHERE gym_id=? ORDER BY is_primary DESC, id ASC', [id]);
    const [plans] = await pool.query('SELECT id, name, plan_type, description, price_cents, currency, duration_days, entries_total, access_per_day, freeze_max_days FROM plans WHERE gym_id=? AND active=1 AND visible=1 ORDER BY price_cents ASC', [id]);
    res.json({ gym, locations, plans });
  } catch (e) { next(e); }
});

module.exports = router;
