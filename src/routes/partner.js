const router = require('express').Router();
const Joi = require('joi');
const { pool } = require('../db');

router.patch('/slots/:id', async (req, res, next) => {
  try {
    const id = +req.params.id;
    const schema = Joi.object({
      is_active: Joi.number().valid(0,1).optional(),
      capacity: Joi.number().min(0).optional(),
      available: Joi.number().min(0).optional()
    }).min(1);
    const body = await schema.validateAsync(req.body);
    const fields = [];
    const params = [];
    for (const k of Object.keys(body)) { fields.push(`${k}=?`); params.push(body[k]); }
    params.push(id);
    const [r] = await pool.query(`UPDATE inventory_slots SET ${fields.join(', ')} WHERE id=?`, params);
    res.json({ affectedRows: r.affectedRows });
  } catch (e) { next(e); }
});

module.exports = router;
