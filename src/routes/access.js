// src/routes/access.js
const router = require('express').Router()
const axios = require('axios')
const Joi = require('joi')
const { requireAuth } = require('../middleware/auth')

const ACCESS_BASE = process.env.ACCESS_BASE || 'http://127.0.0.1:3001'
const USERS_BASE  = process.env.USERS_BASE  || 'http://127.0.0.1:3002'
const TIMEOUT     = +(process.env.ACCESS_TIMEOUT_MS || 5000)

// tutte le rotte access sono protette (staff in palestra)
router.use(requireAuth)

/**
 * POST /partner/access/validate-user
 * body: { token_raw: string, device_id: string }
 * flow:
 *  - chiama A: POST {ACCESS_BASE}/access/validate
 *  - se granted, chiama B: GET {USERS_BASE}/get_user?id_user=&otoken=
 *  - risponde { granted, id_user, user }
 */
router.post('/validate-user', async (req, res, next) => {
  try {
    const schema = Joi.object({
      token_raw: Joi.string().min(8).required(),
      device_id: Joi.string().min(2).required()
    })
    const { token_raw, device_id } = await schema.validateAsync(req.body, { stripUnknown: true })

    // 1) valida token contro servizio A
    const vResp = await axios.post(
      `${ACCESS_BASE}/access/validate`,
      { token_raw, device_id },
      { timeout: TIMEOUT }
    )

    const { granted, id_user } = vResp.data || {}
    if (!granted) {
      return res.status(403).json({ granted: false, reason: 'Accesso negato' })
    }
    if (!id_user) {
      return res.status(502).json({ error: 'Validazione riuscita ma id_user assente dal servizio A' })
    }

    // 2) fetch utente dal servizio B
    // NB: uso token_raw come otoken (come da tua descrizione)
    const uResp = await axios.get(
      `${USERS_BASE}/get_user`,
      { params: { id_user, otoken: token_raw }, timeout: TIMEOUT }
    )

    return res.json({
      granted: true,
      id_user,
      user: uResp.data || null
    })
  } catch (e) {
    // normalizza alcuni errori axios
    if (e.response) {
      return res.status(502).json({ error: 'Upstream error', from: e.response?.config?.url, status: e.response?.status, data: e.response?.data })
    }
    if (e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT') {
      return res.status(502).json({ error: 'Upstream unavailable', code: e.code })
    }
    next(e)
  }
})

module.exports = router
