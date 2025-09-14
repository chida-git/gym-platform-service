// src/routes/access.js
const router = require('express').Router()
const axios = require('axios')
const Joi = require('joi')
const { requireAuth } = require('../middleware/auth')

const DEVICES_BASE = process.env.DEVICES_BASE || 'http://127.0.0.1:3003'
const ACCESS_BASE  = process.env.ACCESS_BASE  || 'http://127.0.0.1:3001'
const USERS_BASE   = process.env.USERS_BASE   || 'http://127.0.0.1:3002'
const TIMEOUT      = +(process.env.ACCESS_TIMEOUT_MS || 5000)

// tutte le rotte /partner/* protette
router.use(requireAuth)

/**
 * POST /partner/access/validate-user
 * body: { token_raw: string }
 * flow:
 *  - usa gym_id dal token partner
 *  - chiama dispositivi: GET {DEVICES_BASE}/devices/by-gym/{gym_id} -> { device_id }
 *  - chiama accesso:     POST {ACCESS_BASE}/access/validate { token_raw, device_id }
 *  - se granted, chiama  GET  {USERS_BASE}/get_user?id_user=&otoken=
 */
router.post('/validate-user', async (req, res, next) => {
  try {
    const schema = Joi.object({ token_raw: Joi.string().min(8).required() })
    const { token_raw } = await schema.validateAsync(req.body, { stripUnknown: true })

    const gym_id = req.partner?.gym_id
    if (!gym_id) return res.status(400).json({ error: 'Missing gym_id in token' })

    // 1) recupera il device_id dal servizio dispositivi
    const dResp = await axios.get(
      `${DEVICES_BASE}/devices/by-gym/${gym_id}`,
      { timeout: TIMEOUT }
    )
    // supporta sia {device_id:'...'} che {id:'...'}
    const device_id = dResp.data?.primary_device_id || dResp.data?.id
    console.log(device_id)
    if (!device_id) {
      return res.status(502).json({ error: 'devices/by-gym: device_id assente', data: dResp.data })
    }

    // 2) valida accesso
    const vResp = await axios.post(
      `${ACCESS_BASE}/access/validate`,
      { token_raw, device_id },
      { timeout: TIMEOUT }
    )
    const { granted, id_user } = vResp.data || {}
    if (!granted) return res.status(403).json({ granted: false, reason: 'Accesso negato' })
    if (!id_user) return res.status(502).json({ error: 'Validazione OK ma id_user mancante' })

    // dentro router.post('/validate-user', ...)
    // 3) ottieni utente "light" dal servizio utenti
    const uResp = await axios.get(
      `${USERS_BASE}/get_user_less`,
      { params: { id_user }, timeout: TIMEOUT }
    )
    console.log(uResp);
    // la risposta è un array del tipo:
    // [ { name: "Davide", surname: "Rossi", mail: "..." } ]
    const arr = Array.isArray(uResp.data) ? uResp.data : []
    const userLess = arr[0] || null

    return res.json({
      granted: true,
      id_user,
      device_id,
      user: userLess    // <- chiave 'user' compatibile col FE
    })
  } catch (e) {
    if (e.response) {
      // errore dal servizio esterno
      return res.status(502).json({
        error: 'Upstream error',
        from: e.response?.config?.url,
        status: e.response?.status,
        data: e.response?.data
      })
    }
    if (e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT') {
      return res.status(502).json({ error: 'Upstream unavailable', code: e.code })
    }
    next(e)
  }
})

module.exports = router
