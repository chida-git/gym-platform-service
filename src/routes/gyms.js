const router = require('express').Router();
const Joi = require('joi');
const { pool } = require('../db');

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

module.exports = router;