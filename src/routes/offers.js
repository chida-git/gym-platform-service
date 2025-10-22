// src/routes/offers.js
const express = require('express');
const { body, query, param } = require('express-validator');
const router = express.Router();
const { pool } = require('../db');


const asyncH = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * OFFERTE (plan_offers)
 */
router.post('/offers',
  [
    body('gym_id').isInt().toInt(),
    body('plan_id').optional({ nullable: true }).isInt().toInt(),
    body('name').isString().trim(),
    body('description').optional().isString().trim(),
    body('offer_type').isIn(['percentage','fixed','trial','price_override']),
    body('discount_percent').optional({ nullable: true }).isFloat({ min: 0, max: 100 }),
    body('discount_amount').optional({ nullable: true }).isFloat({ min: 0 }),
    body('price_override').optional({ nullable: true }).isFloat({ min: 0 }),
    body('promo_code').optional({ nullable: true }).isString().trim(),
    body('start_at').optional({ nullable: true }).isISO8601(),
    body('end_at').optional({ nullable: true }).isISO8601()
  ],
  asyncH(async (req, res) => {
    const payload = req.body;
    const [r] = await pool.query(`
      INSERT INTO plan_offers
        (gym_id, plan_id, name, description, offer_type, discount_percent, discount_amount, price_override, promo_code, start_at, end_at, is_active, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1,NOW())`,
      [payload.gym_id, payload.plan_id || null, payload.name, payload.description || null,
       payload.offer_type, payload.discount_percent || null, payload.discount_amount || null,
       payload.price_override || null, payload.promo_code || null, payload.start_at || null, payload.end_at || null]
    );
    res.status(201).json({ id: r.insertId });
  })
);

router.get('/offers',
  [
    query('gym_id').isInt().toInt(),
    query('active_only').optional().isBoolean(),
    query('limit').optional().isInt({ min:1, max:200 }).toInt(),
    query('offset').optional().isInt({ min:0 }).toInt(),
  ],
  asyncH(async (req, res) => {
    const { gym_id, active_only, limit=50, offset=0 } = req.query;
    const wh = ['gym_id=?']; const pr=[gym_id];
    if (active_only) wh.push('is_active=1');
    const [rows] = await pool.query(
      `SELECT * FROM plan_offers WHERE ${wh.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...pr, Number(limit), Number(offset)]
    );
    res.json(rows);
  })
);

router.patch('/offers/:id',
  [
    param('id').isInt().toInt(),
    body('name').optional().isString().trim(),
    body('description').optional().isString().trim(),
    body('offer_type').optional().isIn(['percentage','fixed','trial','price_override']),
    body('discount_percent').optional({ nullable: true }).isFloat({ min: 0, max: 100 }),
    body('discount_amount').optional({ nullable: true }).isFloat({ min: 0 }),
    body('price_override').optional({ nullable: true }).isFloat({ min: 0 }),
    body('promo_code').optional({ nullable: true }).isString().trim(),
    body('start_at').optional({ nullable: true }).isISO8601(),
    body('end_at').optional({ nullable: true }).isISO8601(),
    body('is_active').optional().isBoolean()
  ],
  asyncH(async (req, res) => {
    const { id } = req.params;
    const fields = []; const pr = [];
    const payload = req.body;
    const cols = ['name','description','offer_type','discount_percent','discount_amount','price_override','promo_code','start_at','end_at'];
    cols.forEach(k => { if (k in payload) { fields.push(`${k}=?`); pr.push(payload[k]); }});
    if ('is_active' in payload) { fields.push('is_active=?'); pr.push(payload.is_active ? 1 : 0); }
    if (!fields.length) return res.json({ updated: 0 });
    await pool.query(`UPDATE plan_offers SET ${fields.join(', ')}, updated_at = NOW() WHERE id=?`, [...pr, id]);
    res.json({ updated: 1 });
  })
);

/**
 * Collegare/scollegare offerte a una campagna
 */
router.post('/marketing/campaigns/:id/offers',
  [
    param('id').isInt().toInt(),
    body('offer_ids').isArray({ min: 1 }),
    body('offer_ids.*').isInt().toInt()
  ],
  asyncH(async (req, res) => {
    const { id } = req.params;
    const rows = req.body.offer_ids.map(oid => [id, oid]);
    await pool.query(`INSERT IGNORE INTO campaign_offers (campaign_id, offer_id) VALUES ?`, [rows]);
    res.json({ attached: rows.length });
  })
);

router.delete('/marketing/campaigns/:id/offers/:offerId',
  [ param('id').isInt().toInt(), param('offerId').isInt().toInt() ],
  asyncH(async (req, res) => {
    const { id, offerId } = req.params;
    const [r] = await pool.query(`DELETE FROM campaign_offers WHERE campaign_id=? AND offer_id=?`, [id, offerId]);
    res.json({ removed: r.affectedRows });
  })
);

/**
 * Redemption (al momento dell'acquisto)
 */
router.post('/offers/:id/redeem',
  [
    param('id').isInt().toInt(),
    body('user_id').isInt().toInt(),
    body('subscription_id').optional({ nullable: true }).isInt().toInt()
  ],
  asyncH(async (req, res) => {
    const { id } = req.params;
    const { user_id, subscription_id = null } = req.body;
    const [r] = await pool.query(
      `INSERT INTO offer_redemptions (offer_id, user_id, subscription_id, redeemed_at)
       VALUES (?,?,?,NOW())`,
      [id, user_id, subscription_id]
    );
    res.status(201).json({ id: r.insertId });
  })
);

module.exports = router;
