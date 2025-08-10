const router = require('express').Router();
const Joi = require('joi');
const { pool } = require('../db');

// GET /gyms?lat=&lon=&radius=&zone=
router.get('/', async (req, res, next) => {
  try {
    const schema = Joi.object({
      lat: Joi.number().min(-90).max(90).optional(),
      lon: Joi.number().min(-180).max(180).optional(),
      radius: Joi.number().min(100).max(20000).default(2000),
      zone: Joi.string().max(120).optional()
    });
    const q = await schema.validateAsync(req.query);

    let sql = `SELECT gl.id as location_id, g.id as gym_id, g.name, gl.address_line1, gl.zone_label,
                      gl.latitude, gl.longitude`;
    const params = [];
    const where = [];
    let order = ' ORDER BY g.name ASC';

    if (q.zone) {
      where.push('gl.zone_label = ?');
      params.push(q.zone);
    }

    if (q.lat != null && q.lon != null) {
      const mode = (process.env.GEO_MODE || 'auto').toLowerCase();
      if (mode === 'haversine') {
        sql += `, (6371000 * ACOS(LEAST(1, COS(RADIANS(?)) * COS(RADIANS(gl.latitude)) *
                     COS(RADIANS(gl.longitude) - RADIANS(?)) + SIN(RADIANS(?)) * SIN(RADIANS(gl.latitude))))) AS meters`;
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

// GET /gyms/near/:gymId?radius=2000  -> usa la location primaria della palestra per cercare vicini
router.get('/near/:gymId', async (req, res, next) => {
  try {
    const gymId = +req.params.gymId;
    const radius = Math.max(100, Math.min(20000, +(req.query.radius || 2000)));
    if (!gymId) return res.status(400).json({ error: 'gymId required' });

    const [locRows] = await pool.query(
      `SELECT latitude, longitude FROM gym_locations
       WHERE gym_id = ?
       ORDER BY is_primary DESC, id ASC
       LIMIT 1`, [gymId]
    );
    if (!locRows.length) return res.status(404).json({ error: 'Gym location not found' });

    const { latitude: lat, longitude: lon } = locRows[0];

    let sql = `SELECT gl.id as location_id, g.id as gym_id, g.name, gl.address_line1, gl.zone_label,
                      gl.latitude, gl.longitude`;
    const params = [];
    let order = ' ORDER BY g.name ASC';

    const mode = (process.env.GEO_MODE || 'auto').toLowerCase();
    if (mode === 'haversine') {
      sql += `, (6371000 * ACOS(LEAST(1, COS(RADIANS(?)) * COS(RADIANS(gl.latitude)) *
                   COS(RADIANS(gl.longitude) - RADIANS(?)) + SIN(RADIANS(?)) * SIN(RADIANS(gl.latitude))))) AS meters`;
      params.push(lat, lon, lat);
      const where = ' WHERE (6371000 * ACOS(LEAST(1, COS(RADIANS(?)) * COS(RADIANS(gl.latitude)) * COS(RADIANS(gl.longitude) - RADIANS(?)) + SIN(RADIANS(?)) * SIN(RADIANS(gl.latitude))))) <= ? ';
      params.push(lat, lon, lat, radius);
      order = ' ORDER BY meters ASC';
      sql += ` FROM gym_locations gl JOIN gyms g ON g.id = gl.gym_id ` + where + order + ' LIMIT 100';
    } else {
      sql += `, ST_Distance_Sphere(gl.location, ST_SRID(POINT(?, ?), 4326)) AS meters`;
      params.push(lon, lat);
      const where = ' WHERE ST_Distance_Sphere(gl.location, ST_SRID(POINT(?, ?), 4326)) <= ? ';
      params.push(lon, lat, radius);
      order = ' ORDER BY meters ASC';
      sql += ` FROM gym_locations gl JOIN gyms g ON g.id = gl.gym_id ` + where + order + ' LIMIT 100';
    }

    const [rows] = await pool.query(sql, params);
    res.json({ origin: { gym_id: gymId, lat, lon, radius }, results: rows });
  } catch (err) { next(err); }
});

module.exports = router;


// GET /gyms/:id  -> dettaglio palestra con sedi e piani attivi/visibili
router.get('/:id', async (req, res, next) => {
  try {
    const id = +req.params.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    const [[gym]] = await pool.query('SELECT id, name, vat_number, email, phone, status, created_at, updated_at FROM gyms WHERE id=?', [id]);
    if (!gym) return res.status(404).json({ error: 'Gym not found' });

    const [locations] = await pool.query(
      `SELECT id, address_line1, address_line2, city, province, postal_code, zone_label,
              latitude, longitude, is_primary, opening_hours
       FROM gym_locations WHERE gym_id = ? ORDER BY is_primary DESC, id ASC`, [id]);

    const [plans] = await pool.query(
      `SELECT id, name, plan_type, description, price_cents, currency,
              duration_days, entries_total, access_per_day, freeze_max_days
       FROM plans WHERE gym_id = ? AND active = 1 AND visible = 1
       ORDER BY price_cents ASC`, [id]);

    res.json({ gym, locations, plans });
  } catch (err) { next(err); }
});
