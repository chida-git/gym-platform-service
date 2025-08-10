const router = require('express').Router();
const Joi = require('joi');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';

function signPartner(u){
  return jwt.sign({ id: u.id, gym_id: u.gym_id, email: u.email, role: u.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

router.post('/partner/login', async (req, res, next) => {
  try {
    const schema = Joi.object({ email: Joi.string().email().required(), password: Joi.string().min(6).required() });
    const { email, password } = await schema.validateAsync(req.body);
    const [[u]] = await pool.query('SELECT id, gym_id, email, full_name, role, password_hash, status FROM partner_users WHERE email=? AND status="active"', [email]);
    if (!u) return res.status(401).json({ error: 'Credenziali non valide' });
    const ok = await bcrypt.compare(password, u.password_hash || '');
    if (!ok) return res.status(401).json({ error: 'Credenziali non valide' });
    const token = signPartner(u);
    res.json({ token, partner: { id: u.id, gym_id: u.gym_id, email: u.email, full_name: u.full_name, role: u.role } });
  } catch (e) { next(e); }
});

module.exports = router;
