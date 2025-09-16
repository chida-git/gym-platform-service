const router = require('express').Router()
const Joi = require('joi')
const { pool } = require('../db')
const { requireAuth } = require('../middleware/auth')
const { publishSafe } = require('../mq')

router.use(requireAuth)

// CREATE plan  → DB (tx) + eventi plan.upsert.* e price.upsert.*
router.post('/plans', async (req, res, next) => {
  const schema = Joi.object({
    gym_id: Joi.number().required(),
    name: Joi.string().max(180).required(),
    plan_type: Joi.string().valid('monthly','pack','daypass','trial','annual').required(),
    description: Joi.string().allow(null,'').optional(),
    price_cents: Joi.number().min(0).required(),
    currency: Joi.string().length(3).default('EUR'),
    duration_days: Joi.number().allow(null),
    entries_total: Joi.number().allow(null),
    access_per_day: Joi.number().allow(null),
    freeze_max_days: Joi.number().min(0).default(0),
    visible: Joi.number().valid(0,1).default(1),
    active: Joi.number().valid(0,1).default(1)
  })
  try {
    const input = await schema.validateAsync(req.body, { stripUnknown: true })
    if (input.gym_id !== req.partner.gym_id) return res.status(403).json({ error: 'Forbidden' })

    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const [ins] = await conn.query(
        `INSERT INTO plans (gym_id, name, plan_type, description, price_cents, currency, duration_days, entries_total, access_per_day, freeze_max_days, visible, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [input.gym_id, input.name, input.plan_type, input.description || null, input.price_cents, input.currency,
         input.duration_days || null, input.entries_total || null, input.access_per_day || null, input.freeze_max_days, input.visible, input.active]
      )
      const planId = ins.insertId

      // storico prezzi
      await conn.query(
        `INSERT INTO price_history (plan_id, gym_id, old_price_cents, new_price_cents, currency, changed_by)
         VALUES (?, ?, NULL, ?, ?, ?)`,
        [planId, input.gym_id, input.price_cents, input.currency || 'EUR', req.partner.id]
      )

      await conn.commit()
      res.status(201).json({ id: planId })

      // PUBLISH dopo il commit
      const ts = new Date().toISOString()
      publishSafe(`plan.upsert.${input.gym_id}`, {
        event: 'plan.upsert', plan_id: planId, gym_id: input.gym_id,
        name: input.name, plan_type: input.plan_type, visible: input.visible, active: input.active, ts
      }).catch(()=>{})
      publishSafe(`price.upsert.${input.gym_id}`, {
        event: 'price.upsert', plan_id: planId, gym_id: input.gym_id,
        price_cents: input.price_cents, currency: input.currency || 'EUR',
        public: !!input.visible && !!input.active, ts
      }).catch(()=>{})
    } catch (e) { await conn.rollback(); throw e } finally { conn.release() }
  } catch (e) { next(e) }
})

// UPDATE plan → DB (tx) + evento plan.upsert.* e/o price.upsert.*|price.archive.*
router.patch('/plans/:id', async (req, res, next) => {
  const schema = Joi.object({
    price_cents: Joi.number().min(0),
    currency: Joi.string().length(3),
    freeze_max_days: Joi.number().min(0).max(365),
    visible: Joi.number().valid(0,1),
    active: Joi.number().valid(0,1),
    name: Joi.string().max(180),
    plan_type: Joi.string().valid('monthly','pack','daypass','trial','annual')
  }).min(1)
  try {
    const id = +req.params.id
    const body = await schema.validateAsync(req.body, { stripUnknown: true })

    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()

      // blocco il piano
      const [[prev]] = await conn.query('SELECT * FROM plans WHERE id=? FOR UPDATE', [id])
      if (!prev) { await conn.rollback(); return res.status(404).json({ error: 'Plan not found' }) }
      if (prev.gym_id !== req.partner.gym_id) { await conn.rollback(); return res.status(403).json({ error: 'Forbidden' }) }

      // costruisci update
      const fields = [], params = []
      for (const k of Object.keys(body)) { fields.push(`${k}=?`); params.push(body[k]) }
      params.push(id)

      if (fields.length) {
        await conn.query(`UPDATE plans SET ${fields.join(', ')}, updated_at=NOW() WHERE id=?`, params)
      }

      // storico prezzo se è cambiato
      const priceChanged = Object.prototype.hasOwnProperty.call(body, 'price_cents') || Object.prototype.hasOwnProperty.call(body, 'currency')
      let newPrice = prev.price_cents, newCurr = prev.currency
      if (priceChanged) {
        newPrice = body.price_cents ?? prev.price_cents
        newCurr  = body.currency ?? prev.currency
        await conn.query(
          `INSERT INTO price_history (plan_id, gym_id, old_price_cents, new_price_cents, currency, changed_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [id, prev.gym_id, prev.price_cents, newPrice, newCurr, req.partner.id]
        )
      }

      await conn.commit()
      res.json({ affectedRows: 1 })

      // PUBLISH dopo commit
      const [[p2]] = await pool.query('SELECT id, gym_id, name, plan_type, price_cents, currency, visible, active FROM plans WHERE id=?', [id])
      if (!p2) return

      const ts = new Date().toISOString()
      const touched = Object.keys(body)
      const priceTouched = touched.some(k => ['price_cents','currency','visible','active'].includes(k))
      const planTouched  = touched.some(k => ['name','plan_type','visible','active'].includes(k))

      if (planTouched) {
        publishSafe(`plan.upsert.${p2.gym_id}`, {
          event: 'plan.upsert', plan_id: p2.id, gym_id: p2.gym_id,
          name: p2.name, plan_type: p2.plan_type, visible: p2.visible, active: p2.active, ts
        }).catch(()=>{})
      }

      if (priceTouched) {
        const isArchived = (p2.visible == 0) || (p2.active == 0)
        const key = isArchived ? 'price.archive' : 'price.upsert'
        publishSafe(`${key}.${p2.gym_id}`, {
          event: key, plan_id: p2.id, gym_id: p2.gym_id,
          price_cents: p2.price_cents, currency: p2.currency || 'EUR',
          public: !isArchived, ts
        }).catch(()=>{})
      }
    } catch (e) { await conn.rollback(); throw e } finally { conn.release() }
  } catch (e) { next(e) }
})

// DELETE plan → DB + eventi plan.archive.* e price.archive.*
router.delete('/plans/:id', async (req, res, next) => {
  try {
    const id = +req.params.id
    const [[p]] = await pool.query('SELECT id, gym_id FROM plans WHERE id=?', [id])
    if (!p) return res.status(404).json({ error: 'Plan not found' })
    if (p.gym_id !== req.partner.gym_id) return res.status(403).json({ error: 'Forbidden' })

    const [r] = await pool.query('DELETE FROM plans WHERE id=?', [id])
    res.json({ affectedRows: r.affectedRows })

    const ts = new Date().toISOString()
    publishSafe(`plan.archive.${p.gym_id}`, { event: 'plan.archive', plan_id: id, gym_id: p.gym_id, ts }).catch(()=>{})
    publishSafe(`price.archive.${p.gym_id}`, { event: 'price.archive', plan_id: id, gym_id: p.gym_id, ts }).catch(()=>{})
  } catch (e) { next(e) }
})
