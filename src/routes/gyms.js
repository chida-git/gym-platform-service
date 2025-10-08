const router = require('express').Router();
const Joi = require('joi');
const { pool } = require('../db');
const multer = require('multer');
const path = require('path');
const AWS = require('aws-sdk');
const sharp = require('sharp');
const { requireAuth } = require('../middleware/auth');
const { publishSafe } = require('../mq')  // <-- usa publishSafe

const s3 = new AWS.S3({
  region: process.env.AWS_REGION,          // es: 'eu-central-1'
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});
//const { uploadBuffer, listByPrefix, deleteKey } = require('../s3');

//router.use(requireAuth);

// ───────────────────────────────────────────────────────
// GET: profilo palestra
// GET /gyms/:id/profile
// ───────────────────────────────────────────────────────
router.get('/:id/profile', async (req, res, next) => {
  try {
    const id = +req.params.id;
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id non valido' });

    const [[row]] = await pool.query(
      `SELECT name, email, phone, description, web, opening_hours
         FROM gyms
        WHERE id = ?`,
      [id]
    );
    if (!row) return res.status(404).json({ error: 'Gym not found' });

    // se MySQL restituisce JSON come stringa, parsalo
    if (typeof row.opening_hours === 'string') {
      try { row.opening_hours = JSON.parse(row.opening_hours); } catch { row.opening_hours = null; }
    }

    return res.json(row);
  } catch (err) { next(err); }
});

// ───────────────────────────────────────────────────────
// PUT: aggiorna profilo palestra
// PUT /gyms/:id/profile
// Body JSON: { name, email, phone, description, web }
// ───────────────────────────────────────────────────────
const timeRx = /^([01]\d|2[0-3]):[0-5]\d$/;

const slotSchema = Joi.object({
  open:  Joi.string().pattern(timeRx).required(),
  close: Joi.string().pattern(timeRx).required()
});

const daySchema = Joi.array().items(slotSchema).max(8); // fino a 8 intervalli al giorno

const openingHoursSchema = Joi.object({
  mon: daySchema.default([]),
  tue: daySchema.default([]),
  wed: daySchema.default([]),
  thu: daySchema.default([]),
  fri: daySchema.default([]),
  sat: daySchema.default([]),
  sun: daySchema.default([])
}).unknown(false);

const profileSchema = Joi.object({
  name: Joi.string().max(180).required(),
  email: Joi.string().email().max(180).allow(null, ''),       // opzionale
  phone: Joi.string().max(40).allow(null, ''),                 // opzionale
  description: Joi.string().max(500).allow(null, ''),          // opzionale
  web: Joi.string().uri().max(2000).allow(null, ''),            // opzionale
  opening_hours: openingHoursSchema.allow(null) // opzionale o null
});

router.put('/:id/profile', async (req, res, next) => {
  try {
    const id = +req.params.id;
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id non valido' });

    const payload = await profileSchema.validateAsync(req.body, { stripUnknown: true });
    const toNull = v => (v === '' ? null : v);

    const sets = [
      'name = ?',
      'email = ?',
      'phone = ?',
      'description = ?',
      'web = ?'
    ];
    const params = [
      payload.name,
      toNull(payload.email ?? null),
      toNull(payload.phone ?? null),
      toNull(payload.description ?? null),
      toNull(payload.web ?? null)
    ];

    // se opening_hours è stato passato, includilo
    if (Object.prototype.hasOwnProperty.call(payload, 'opening_hours')) {
      sets.push('opening_hours = ?');
      params.push(payload.opening_hours === null ? null : JSON.stringify(payload.opening_hours));
    }

    // updated_at
    sets.push('updated_at = NOW()');

    const [result] = await pool.query(
      `UPDATE gyms SET ${sets.join(', ')} WHERE id = ?`,
      [...params, id]
    );

    if (result.affectedRows === 0) return res.status(404).json({ error: 'Gym not found' });

    const [[updated]] = await pool.query(
      `SELECT name, email, phone, description, web, opening_hours
         FROM gyms
        WHERE id = ?`,
      [id]
    );

    if (typeof updated.opening_hours === 'string') {
      try { updated.opening_hours = JSON.parse(updated.opening_hours); } catch { updated.opening_hours = null; }
    }

    const ts = new Date().toISOString();
    publishSafe(`personal.upsert.${p.gym_id}`, { event: 'personal.upsert', opening_hours: updated.opening_hours, name: updated.name, email: updated.email, phone: updated.phone, description: updated.description, web: updated.web, ts }).catch(()=>{})
    return res.json({ ok: true, gym: updated });
  } catch (err) {
    if (err.isJoi) return res.status(400).json({ error: err.message });
    next(err);
  }
});

function isValidId(x) { return /^\d+$/.test(String(x)); }
function sanitizeName(name) { return String(name).replace(/[^a-zA-Z0-9._-]/g, '_'); }

function buildPublicUrl(key) {
  const base = process.env.S3_PUBLIC_BASE; // es. CloudFront o S3 website
  // Se esplicitamente pubblico
  if (process.env.S3_PUBLIC_MODE === 'public' && base) {
    return `${base}/${key}`;
  }
  // Default: usa URL firmati
  return s3.getSignedUrl('getObject', {
    Bucket: process.env.S3_BUCKET,
    Key: key,
    Expires: 3600 // 1h (puoi aumentare/ridurre)
  });
}

async function uploadBuffer({ Bucket, Key, Body, ContentType, CacheControl }) {
  return s3.putObject({ Bucket, Key, Body, ContentType, CacheControl }).promise();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 }, // 10MB, max 10 file
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(file.mimetype);
    cb(ok ? null : new Error('Formato non supportato (usa jpg/png/webp/avif)'), ok);
  }
});

/**
 * UPLOAD immagini presentazione (max 10)
 * - Rinomina in 1.jpg, 2.jpg, ...
 * - Ridimensiona a max 1920x1080
 * - Blocca se già presenti 10 immagini
 */
router.post('/:gymId/presentation/images', upload.array('images', 10), async (req, res, next) => {
  try {
    const bucket = process.env.S3_BUCKET;
    const { gymId } = req.params;

    if (!isValidId(gymId))
      return res.status(400).json({ error: 'gymId non valido' });

    if (!req.files || req.files.length === 0)
      return res.status(400).json({ error: 'Nessun file caricato' });

    const prefix = `gyms/${gymId}/gym_presentation/`;
    const maxWidth = 1920;
    const maxHeight = 1080;
    const maxImages = 10;

    // 🔹 1. Legge gli oggetti esistenti
    const listed = await s3.listObjectsV2({
      Bucket: bucket,
      Prefix: prefix
    }).promise();

    // 🔹 2. Trova numeri già usati (1, 2, 3, …)
    const existing = (listed.Contents || [])
      .map(o => parseInt(path.basename(o.Key, path.extname(o.Key))))
      .filter(n => !isNaN(n))
      .sort((a, b) => a - b);

    const existingCount = existing.length;
    if (existingCount >= maxImages) {
      return res.status(400).json({
        error: `Hai già ${existingCount} immagini. Limite massimo: ${maxImages}.`
      });
    }

    // 🔹 3. Calcola quanti nuovi file si possono caricare
    const availableSlots = maxImages - existingCount;
    if (req.files.length > availableSlots) {
      return res.status(400).json({
        error: `Puoi caricare al massimo ${availableSlots} immagini aggiuntive (limite totale ${maxImages}).`
      });
    }

    // 🔹 4. Determina il prossimo numero disponibile
    let counter = existingCount > 0 ? Math.max(...existing) + 1 : 1;
    const uploaded = [];

    for (const f of req.files) {
      const safeExt = path.extname(f.originalname).toLowerCase() || '.jpg';
      const filename = `${counter}${safeExt}`;
      const Key = `${prefix}${filename}`;

      // 🔹 5. Ridimensiona se troppo grande
      const resizedBuffer = await sharp(f.buffer)
        .resize({
          width: maxWidth,
          height: maxHeight,
          fit: 'inside',
          withoutEnlargement: true
        })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();

      // 🔹 6. Upload su S3
      await s3.putObject({
        Bucket: bucket,
        Key,
        Body: resizedBuffer,
        ContentType: 'image/jpeg',
        CacheControl: 'public, max-age=31536000, immutable'
      }).promise();

      uploaded.push({
        key: Key,
        filename,
        size: resizedBuffer.length,
        url: buildPublicUrl(Key)
      });

      counter++;
    }

    return res.json({
      ok: true,
      count: uploaded.length,
      totalImages: existingCount + uploaded.length,
      uploaded
    });
  } catch (err) {
    if (err && /Formato non supportato/i.test(err.message)) {
      return res.status(415).json({ error: err.message });
    }
    next(err);
  }
});

/**
 * LISTA IMMAGINI
 * GET /:gymId/presentation/images?limit=10&token=<ContinuationToken>
 * - limit: MaxKeys S3 (default 10)
 * - token: ContinuationToken per paginazione
 */
router.get('/:gymId/presentation/images', async (req, res, next) => {
  try {
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    const bucket = process.env.S3_BUCKET;
    const { gymId } = req.params;
    if (!isValidId(gymId)) return res.status(400).json({ error: 'gymId non valido' });

    const limit = Math.min(parseInt(req.query.limit || '10', 10) || 10, 1000);
    const continuationToken = req.query.token || undefined;

    const prefix = `gyms/${gymId}/gym_presentation/`;

    const listed = await s3.listObjectsV2({
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: limit,
      ContinuationToken: continuationToken
    }).promise();

    // tieni solo i file immagine
    const items = (listed.Contents || [])
      .map(o => o.Key)
      .filter(k => /\.(jpe?g|png|gif|webp|avif)$/i.test(k))
      .map(key => ({
        key,
        filename: key.substring(prefix.length),
        url: buildPublicUrl(key)
      }));

    return res.json({
      ok: true,
      items,
      count: items.length,
      nextToken: listed.IsTruncated ? listed.NextContinuationToken : null
    });
  } catch (err) {
    next(err);
  }
});

/**
 * CANCELLA IMMAGINE
 * DELETE /:gymId/presentation/images/:filename
 */
router.delete('/:gymId/presentation/images/:filename', async (req, res, next) => {
  try {
    const bucket = process.env.S3_BUCKET;
    const { gymId, filename } = req.params;

    if (!isValidId(gymId)) return res.status(400).json({ error: 'gymId non valido' });
    if (!filename) return res.status(400).json({ error: 'filename mancante' });

    // evita path traversal
    const safeFilename = sanitizeName(path.basename(filename));
    const key = `gyms/${gymId}/gym_presentation/${safeFilename}`;

    await s3.deleteObject({ Bucket: bucket, Key: key }).promise();

    return res.json({ ok: true, deleted: { key, filename: safeFilename } });
  } catch (err) {
    if (err.code === 'NoSuchKey') {
      return res.status(404).json({ error: 'Immagine non trovata' });
    }
    next(err);
  }
});

/**
 * GET index (cerca index.jpeg poi index.jpg)
 * Esempio: GET /1/presentation/index
 */
router.get('/:gymId/presentation/index', async (req, res, next) => {
  try {
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    const bucket = process.env.S3_BUCKET;
    const { gymId } = req.params;
    if (!isValidId(gymId)) return res.status(400).json({ error: 'gymId non valido' });

    const baseKey = `gyms/${gymId}/index`;
    const tryKeys = [`${baseKey}.jpeg`, `${baseKey}.jpg`];

    let data = null;
    let foundKey = null;

    for (const Key of tryKeys) {
      try {
        data = await s3.getObject({ Bucket: bucket, Key }).promise();
        foundKey = Key;
        break;
      } catch (e) {
        if (e.code !== 'NoSuchKey' && e.statusCode !== 404) throw e;
      }
    }

    if (!data) return res.status(404).json({ error: 'index non trovato' });

    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    // opzionale: ETag/Last-Modified da S3
    if (data.ETag) res.set('ETag', data.ETag);
    if (data.LastModified) res.set('Last-Modified', data.LastModified.toUTCString());

    return res.send(data.Body);
  } catch (err) {
    next(err);
  }
});


/**
 * PUT index (upload e overwrite)
 * - accetta 1 file multipart col campo "image"
 * - crea/sovrascrive:
 *   gyms/{gymId}/index.jpeg  (500x500)
 *   gyms/{gymId}/marker.jpeg (100x100)
 *
 * Esempio: PUT /1/presentation/index
 */
router.put('/:gymId/presentation/index', upload.single('image'), async (req, res, next) => {
  try {
    const bucket = process.env.S3_BUCKET;
    const { gymId } = req.params;
    if (!isValidId(gymId)) return res.status(400).json({ error: 'gymId non valido' });
    if (!req.file) return res.status(400).json({ error: 'Nessun file caricato' });

    // accettiamo solo immagini
    if (!/^image\//i.test(req.file.mimetype)) {
      return res.status(415).json({ error: 'Formato non supportato' });
    }

    const base = `gyms/${gymId}`;
    const jpegOpts = { quality: 85, mozjpeg: true };

    // genera versioni
    const index500 = await sharp(req.file.buffer)
      .resize(500, 500, { fit: 'cover' })
      .jpeg(jpegOpts)
      .toBuffer();

    const marker100 = await sharp(req.file.buffer)
      .resize(100, 100, { fit: 'cover' })
      .jpeg(jpegOpts)
      .toBuffer();

    // upload (overwrite)
    await Promise.all([
      uploadBuffer({
        Bucket: bucket,
        Key: `${base}/index.jpeg`,
        Body: index500,
        ContentType: 'image/jpeg',
        CacheControl: 'public, max-age=31536000, immutable'
      }),
      uploadBuffer({
        Bucket: bucket,
        Key: `${base}/marker.jpg`,
        Body: marker100,
        ContentType: 'image/jpeg',
        CacheControl: 'public, max-age=31536000, immutable'
      })
    ]);

    return res.json({
      ok: true,
      updated: [
        { key: `${base}/index.jpeg`, size: index500.length },
        { key: `${base}/marker.jpg`, size: marker100.length }
      ]
    });
  } catch (err) {
    next(err);
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
