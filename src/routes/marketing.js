// src/routes/marketing.js
const express = require('express');
const { body, query, param } = require('express-validator');
const router = express.Router();
const { pool } = require('../db');

const asyncH = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * CONTATTI (marketing_contacts) — ogni contatto è un utente della stessa palestra
 */

// Sync tutti gli users della palestra in marketing_contacts
router.post('/marketing/contacts/sync',
  [ body('gym_id').isInt().toInt() ],
  asyncH(async (req, res) => {
    const { gym_id } = req.body;
    await pool.query(`
      INSERT INTO marketing_contacts (user_id, gym_id, subscribed, consent_at, created_at)
      SELECT u.id, u.gym_id, 1, NOW(), NOW()
      FROM users u
      WHERE u.gym_id = ?
      ON DUPLICATE KEY UPDATE updated_at = NOW()`, [gym_id]);
    const [cnt] = await pool.query(`SELECT COUNT(*) as total FROM marketing_contacts WHERE gym_id=?`, [gym_id]);
    res.json({ synced: cnt[0].total });
  })
);

// Iscrizione/aggiornamento contatto (per singolo user_id)
router.post('/marketing/contacts',
  [
    body('user_id').isInt().toInt(),
    body('gym_id').isInt().toInt(),
    body('subscribed').optional().isBoolean(),
    body('tags').optional().isArray()
  ],
  asyncH(async (req, res) => {
    const { user_id, gym_id, subscribed = true, tags = null } = req.body;
    await pool.query(`
      INSERT INTO marketing_contacts (user_id, gym_id, subscribed, consent_at, tags, created_at)
      VALUES (?, ?, ?, IF(?=1, NOW(), NULL), ?, NOW())
      ON DUPLICATE KEY UPDATE
        subscribed = VALUES(subscribed),
        tags = VALUES(tags),
        updated_at = NOW(),
        consent_at = IF(VALUES(subscribed)=1, IFNULL(consent_at, NOW()), consent_at)
    `, [user_id, gym_id, subscribed ? 1 : 0, subscribed ? 1 : 0, tags ? JSON.stringify(tags) : null]);
    res.status(201).json({ ok: true });
  })
);

router.patch('/marketing/contacts/:id',
  [
    param('id').isInt().toInt(),
    body('subscribed').optional().isBoolean(),
    body('tags').optional().isArray()
  ],
  asyncH(async (req, res) => {
    const { id } = req.params;
    const { subscribed, tags } = req.body;
    await pool.query(
      `UPDATE marketing_contacts 
       SET 
         ${subscribed === undefined ? '' : 'subscribed = ?, '}${tags === undefined ? '' : 'tags = ?, '}
         ${subscribed ? 'consent_at = IFNULL(consent_at, NOW()), ' : ''}
         updated_at = NOW()
       WHERE id = ?`,
      [
        ...(subscribed === undefined ? [] : [subscribed ? 1 : 0]),
        ...(tags === undefined ? [] : [JSON.stringify(tags || null)]),
        id
      ]
    );
    res.json({ updated: 1 });
  })
);

// GET /marketing/contacts?gym_id=1&search=...&subscribed=1&limit=50&offset=0
// GET /marketing/contacts?gym_id=1&search=&only_subscribed=1&only_external=0&limit=50&offset=0
router.get('/marketing/contacts',
  [
    query('gym_id').isInt().toInt(),
    query('search').optional().isString().trim(),
    query('only_subscribed').optional().isInt({ min:0, max:1 }).toInt(),
    query('only_external').optional().isInt({ min:0, max:1 }).toInt(),
    query('limit').optional().isInt({ min:1, max:200 }).toInt(),
    query('offset').optional().isInt({ min:0 }).toInt(),
  ],
  asyncH(async (req, res) => {
    const { gym_id, search, only_subscribed, only_external, limit=50, offset=0 } = req.query;
    const wh = ['mc.gym_id = ?']; const pr=[gym_id];
    if (typeof only_subscribed !== 'undefined') { wh.push('mc.subscribed = ?'); pr.push(only_subscribed); }
    if (typeof only_external !== 'undefined') { wh.push('mc.user_id IS ' + (only_external ? 'NULL' : 'NOT NULL')); }
    if (search) {
      wh.push('(' +
        'COALESCE(u.full_name, mc.full_name, "") LIKE ? OR ' +
        'COALESCE(u.email, mc.email, "") LIKE ? OR ' +
        'COALESCE(u.phone, mc.phone, "") LIKE ?' +
      ')');
      pr.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const [rows] = await pool.query(
      `SELECT
         mc.id,
         mc.user_id,
         mc.subscribed,
         mc.tags,
         COALESCE(u.full_name, mc.full_name) AS full_name,
         COALESCE(u.email, mc.email)       AS email,
         COALESCE(u.phone, mc.phone)       AS phone
       FROM marketing_contacts mc
       LEFT JOIN users u ON u.id = mc.user_id
       WHERE ${wh.join(' AND ')}
       ORDER BY mc.id DESC
       LIMIT ? OFFSET ?`,
      [...pr, Number(limit), Number(offset)]
    );
    res.json(rows);
  })
);

router.post('/marketing/contacts/external',
  [
    body('gym_id').isInt().toInt(),
    body('email').isEmail().trim().isLength({ max:180 }),
    body('full_name').optional().isString().trim().isLength({ max:180 }),
    body('phone').optional().isString().trim().isLength({ max:40 }),
    body('tags').optional().isArray(),
    body('subscribed').optional().isBoolean()
  ],
  asyncH(async (req, res) => {
    const { gym_id, email, full_name=null, phone=null, tags=null, subscribed=true } = req.body;

    // 👉 auto-link al users se esiste lo stesso email nella stessa palestra
    const [[u]] = await pool.query(`SELECT id FROM users WHERE gym_id=? AND email=?`, [gym_id, email]);
    const user_id = u ? u.id : null;

    await pool.query(`
      INSERT INTO marketing_contacts (gym_id, user_id, email, full_name, phone, tags, subscribed, consent_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, IF(?=1, NOW(), NULL), NOW())
      ON DUPLICATE KEY UPDATE
        -- se nel frattempo è comparso l'utente, colleghiamolo
        user_id   = IF(VALUES(user_id) IS NOT NULL, VALUES(user_id), user_id),
        full_name = VALUES(full_name),
        phone     = VALUES(phone),
        tags      = VALUES(tags),
        subscribed= VALUES(subscribed),
        consent_at= IF(VALUES(subscribed)=1, IFNULL(consent_at, NOW()), consent_at),
        updated_at= NOW()
    `, [gym_id, user_id, email, full_name, phone, tags ? JSON.stringify(tags) : null, subscribed ? 1 : 0, subscribed ? 1 : 0]);

    res.status(201).json({ ok:true, linked_user: !!user_id });
  })
);

// POST /marketing/campaigns/:id/recipients  { contact_ids:[...], replace:true|false }
router.post('/marketing/campaigns/:id/recipients',
  [
    param('id').isInt().toInt(),
    body('contact_ids').isArray({ min:1 }),
    body('contact_ids.*').isInt().toInt(),
    body('replace').optional().isBoolean()
  ],
  asyncH(async (req, res) => {
    const { id } = req.params;
    const { contact_ids, replace = false } = req.body;

    if (replace) {
      await pool.query(`DELETE FROM campaign_recipients WHERE campaign_id=?`, [id]);
    }
    const rows = contact_ids.map(cid => [id, cid]);
    await pool.query(
      `INSERT IGNORE INTO campaign_recipients (campaign_id, contact_id, send_status, created_at)
       VALUES ${rows.map(()=>'(?, ?, "queued", NOW())').join(',')}`,
      rows.flat()
    );

    const [[cnt]] = await pool.query(`SELECT COUNT(*) AS total FROM campaign_recipients WHERE campaign_id=?`, [id]);
    res.json({ recipients_total: Number(cnt.total) });
  })
);


router.post('/marketing/campaigns/:id/ready',
  [ param('id').isInt().toInt() ],
  asyncH(async (req, res) => {
    const { id } = req.params;

    const [[camp]] = await pool.query(
      `SELECT id, gym_id, status FROM newsletter_campaigns WHERE id=?`, [id]
    );
    if (!camp) return res.status(404).json({ error: 'campaign_not_found' });
    if (camp.status === 'sent') return res.status(400).json({ error: 'already_sent' });

    // se non hai ancora scelto destinatari, allora materializza tutti i subscribed
    const [[has]] = await pool.query(
      `SELECT COUNT(*) AS c FROM campaign_recipients WHERE campaign_id=?`, [id]
    );
    if (Number(has.c) === 0) {
      await pool.query(`
        INSERT IGNORE INTO campaign_recipients (campaign_id, contact_id, send_status, created_at)
        SELECT ?, mc.id, 'queued', NOW()
        FROM marketing_contacts mc
        WHERE mc.gym_id = ? AND mc.subscribed = 1
      `, [id, camp.gym_id]);
    }

    await pool.query(`UPDATE newsletter_campaigns SET status='ready', updated_at=NOW() WHERE id=?`, [id]);

    const [[tot]] = await pool.query(
      `SELECT COUNT(*) AS queued FROM campaign_recipients WHERE campaign_id=? AND send_status='queued'`, [id]
    );
    res.json({ ok:true, queued:Number(tot.queued) });
  })
);


/**
 * TEMPLATE
 */
router.post('/marketing/templates',
  [
    body('gym_id').isInt().toInt(),
    body('name').isString().trim(),
    body('subject').optional().isString().trim(),
    body('html').isString(),
    body('text').optional().isString()
  ],
  asyncH(async (req, res) => {
    const { gym_id, name, subject = null, html, text = null } = req.body;
    const [r] = await pool.query(
      `INSERT INTO newsletter_templates (gym_id, name, subject, html, text, created_at) VALUES (?,?,?,?,?,NOW())`,
      [gym_id, name, subject, html, text]
    );
    res.status(201).json({ id: r.insertId });
  })
);

router.get('/marketing/templates',
  [
    query('gym_id').isInt().toInt(),
    query('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
    query('offset').optional().isInt({ min: 0 }).toInt(),
  ],
  asyncH(async (req, res) => {
    const { gym_id, limit = 50, offset = 0 } = req.query;
    const [rows] = await pool.query(
      `SELECT * FROM newsletter_templates WHERE gym_id=? ORDER BY id DESC LIMIT ? OFFSET ?`,
      [gym_id, Number(limit), Number(offset)]
    );
    res.json(rows);
  })
);

// src/routes/marketing.js (aggiungi in alto se non c'è)
const { sendMail } = require('../mailer');

router.post('/marketing/campaigns/:id/send',
  [ param('id').isInt().toInt() ],
  asyncH(async (req, res) => {
    const { id } = req.params;
    const PER_HOUR = Number(process.env.MAILS_PER_HOUR || 100);
    const BATCH_SIZE = Number(process.env.MAIL_BATCH_SIZE || 50);

    const [[camp]] = await pool.query(`
      SELECT c.*, t.html AS tpl_html, t.subject AS tpl_subject
      FROM newsletter_campaigns c
      LEFT JOIN newsletter_templates t ON t.id = c.template_id
      WHERE c.id = ?`, [id]);
    if (!camp) return res.status(404).json({ error: 'campaign_not_found' });

    // 1) Quante email abbiamo spedito nell’ultima ora (su TUTTE le campagne)
    const [[countRow]] = await pool.query(`
      SELECT COUNT(*) AS sent_last_hour
      FROM campaign_recipients
      WHERE send_status='sent' 
        AND send_at > (NOW() - INTERVAL 1 HOUR)
    `);
    const sentLastHour = Number(countRow.sent_last_hour);
    const remainingInWindow = Math.max(0, PER_HOUR - sentLastHour);

    if (remainingInWindow <= 0) {
      // Calcolo quando si sblocca la finestra: prendo la più vecchia send_at nell’ultima ora e aggiungo 60 min
      const [[oldestRow]] = await pool.query(`
        SELECT MIN(send_at) AS oldest
        FROM campaign_recipients
        WHERE send_status='sent'
          AND send_at > (NOW() - INTERVAL 1 HOUR)
      `);
      const nextResetAt = oldestRow.oldest
        ? new Date(new Date(oldestRow.oldest).getTime() + 60 * 60 * 1000)
        : null;
      return res.status(429).json({
        error: 'rate_limited',
        message: 'Limite di 100 email/ora raggiunto',
        next_window_reset_at: nextResetAt
      });
    }

    // 2) Prendo solo i destinatari ancora in coda di QUESTA campagna, limitando al minimo fra batch e quota residua
    const take = Math.min(remainingInWindow, BATCH_SIZE);
    const [recipients] = await pool.query(`
      SELECT mc.id AS contact_id, u.email
      FROM campaign_recipients cr
      JOIN marketing_contacts mc ON mc.id = cr.contact_id
      JOIN users u ON u.id = mc.user_id
      WHERE cr.campaign_id = ? 
        AND cr.send_status='queued'
      ORDER BY cr.id ASC
      LIMIT ?`, [id, take]);

    if (!recipients.length) {
      return res.json({ sent: 0, failed: 0, queued_remaining: 0, allowed_this_call: take });
    }

    const html = camp.content_html || camp.tpl_html;
    const subject = camp.subject || camp.tpl_subject || '(senza oggetto)';

    let sent = 0, failed = 0;

    for (const r of recipients) {
      try {
        await sendMail({
          to: r.email,
          subject,
          html,
          text: html ? html.replace(/<[^>]+>/g, '') : null,
        });
        await pool.query(`
          UPDATE campaign_recipients 
          SET send_status='sent', send_at=NOW(), last_error=NULL 
          WHERE campaign_id=? AND contact_id=?`, [id, r.contact_id]);
        sent++;
      } catch (e) {
        failed++;
        await pool.query(`
          UPDATE campaign_recipients 
          SET send_status='failed', last_error=? 
          WHERE campaign_id=? AND contact_id=?`, [e.message.slice(0,490), id, r.contact_id]);
      }
    }

    // Se non ci sono più queued → segna campagna sent
    const [[remain]] = await pool.query(`
      SELECT COUNT(*) AS queued_remaining
      FROM campaign_recipients 
      WHERE campaign_id=? AND send_status='queued'`, [id]);

    if (Number(remain.queued_remaining) === 0) {
      await pool.query(`UPDATE newsletter_campaigns SET status='sent', sent_at=NOW() WHERE id=?`, [id]);
    } else {
      // altrimenti metti "sending" per chiarezza
      await pool.query(`UPDATE newsletter_campaigns SET status='sending', updated_at=NOW() WHERE id=?`, [id]);
    }

    // info finestra successiva
    const [[countRow2]] = await pool.query(`
      SELECT COUNT(*) AS sent_last_hour
      FROM campaign_recipients
      WHERE send_status='sent' 
        AND send_at > (NOW() - INTERVAL 1 HOUR)
    `);
    const remainQuota = Math.max(0, PER_HOUR - Number(countRow2.sent_last_hour));
    let nextResetAt = null;
    if (remainQuota === 0) {
      const [[oldestRow2]] = await pool.query(`
        SELECT MIN(send_at) AS oldest
        FROM campaign_recipients
        WHERE send_status='sent'
          AND send_at > (NOW() - INTERVAL 1 HOUR)
      `);
      if (oldestRow2.oldest) {
        nextResetAt = new Date(new Date(oldestRow2.oldest).getTime() + 60 * 60 * 1000);
      }
    }

    res.json({
      sent,
      failed,
      queued_remaining: Number(remain.queued_remaining),
      allowed_this_call: take,
      quota_remaining_in_window: remainQuota,
      next_window_reset_at: nextResetAt
    });
  })
);


// Mark campaign as ready and materialize recipients once
router.post('/marketing/campaigns/:id/ready',
  [ param('id').isInt().toInt() ],
  asyncH(async (req, res) => {
    const { id } = req.params;

    // 1) prendo campagna
    const [[camp]] = await pool.query(
      `SELECT id, gym_id, status FROM newsletter_campaigns WHERE id=?`, [id]
    );
    if (!camp) return res.status(404).json({ error: 'campaign_not_found' });
    if (camp.status === 'sent') return res.status(400).json({ error: 'already_sent' });

    // 2) materializzo destinatari solo se non esistono
    await pool.query(`
      INSERT IGNORE INTO campaign_recipients (campaign_id, contact_id, send_status, created_at)
      SELECT ?, mc.id, 'queued', NOW()
      FROM marketing_contacts mc
      WHERE mc.gym_id = ? AND mc.subscribed = 1
    `, [id, camp.gym_id]);

    // 3) metto stato 'ready' (il worker farà il resto)
    await pool.query(`UPDATE newsletter_campaigns SET status='ready', updated_at=NOW() WHERE id=?`, [id]);

    const [[tot]] = await pool.query(
      `SELECT COUNT(*) AS queued FROM campaign_recipients WHERE campaign_id=? AND send_status='queued'`, [id]
    );

    res.json({ ok: true, queued: Number(tot.queued) });
  })
);


/**
 * CAMPAGNE
 */
router.post('/marketing/campaigns',
  [
    body('gym_id').isInt().toInt(),
    body('name').isString().trim(),
    body('subject').isString().trim(),
    body('from_name').isString().trim(),
    body('from_email').isEmail().trim(),
    body('template_id').optional({ nullable: true }).isInt().toInt(),
    body('content_html').optional({ nullable: true }).isString(),
    body('scheduled_at').optional({ nullable: true }).isISO8601()
  ],
  asyncH(async (req, res) => {
    const { gym_id, name, subject, from_name, from_email, template_id = null, content_html = null, scheduled_at = null } = req.body;
    const [r] = await pool.query(
      `INSERT INTO newsletter_campaigns 
       (gym_id, name, subject, from_name, from_email, template_id, content_html, status, scheduled_at, created_at)
       VALUES (?,?,?,?,?,?,?,'draft',?,NOW())`,
      [gym_id, name, subject, from_name, from_email, template_id, content_html, scheduled_at]
    );
    res.status(201).json({ id: r.insertId });
  })
);

router.get('/marketing/campaigns',
  [
    query('gym_id').isInt().toInt(),
    query('status').optional().isIn(['draft','scheduled','sending','sent']),
    query('limit').optional().isInt({ min:1, max:200 }).toInt(),
    query('offset').optional().isInt({ min:0 }).toInt(),
  ],
  asyncH(async (req, res) => {
    const { gym_id, status, limit = 50, offset = 0 } = req.query;
    const wh = ['gym_id=?']; const pr = [gym_id];
    if (status) { wh.push('status=?'); pr.push(status); }
    const [rows] = await pool.query(
      `SELECT * FROM newsletter_campaigns WHERE ${wh.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...pr, Number(limit), Number(offset)]
    );
    res.json(rows);
  })
);

// Materializza destinatari: tutti i contatti subscribed=1 della palestra
router.post('/marketing/campaigns/:id/materialize',
  [ param('id').isInt().toInt() ],
  asyncH(async (req, res) => {
    const { id } = req.params;
    // scopri gym_id della campagna
    const [[camp]] = await pool.query(`SELECT gym_id FROM newsletter_campaigns WHERE id=?`, [id]);
    if (!camp) return res.status(404).json({ error: 'campaign_not_found' });

    await pool.query(`
      INSERT IGNORE INTO campaign_recipients (campaign_id, contact_id, send_status, created_at)
      SELECT ?, mc.id, 'queued', NOW()
      FROM marketing_contacts mc
      WHERE mc.gym_id = ? AND mc.subscribed = 1
    `, [id, camp.gym_id]);

    const [[cnt]] = await pool.query(`SELECT COUNT(*) as total FROM campaign_recipients WHERE campaign_id=?`, [id]);
    res.json({ recipients: cnt.total });
  })
);

// Aggiorna stato (schedule, mark as sending/sent)
router.patch('/marketing/campaigns/:id',
  [
    param('id').isInt().toInt(),
    body('status').optional().isIn(['draft','scheduled','sending','sent']),
    body('scheduled_at').optional({ nullable: true }).isISO8601()
  ],
  asyncH(async (req, res) => {
    const { id } = req.params;
    const sets = []; const pr = [];
    if (req.body.status) { sets.push('status=?'); pr.push(req.body.status); }
    if ('scheduled_at' in req.body) { sets.push('scheduled_at=?'); pr.push(req.body.scheduled_at); }
    if (!sets.length) return res.json({ updated: 0 });
    await pool.query(`UPDATE newsletter_campaigns SET ${sets.join(', ')}, updated_at = NOW() WHERE id=?`, [...pr, id]);
    res.json({ updated: 1 });
  })
);

/**
 * EVENTI (webhook dal provider SMTP: delivered/opened/clicked/…)
 */
router.post('/marketing/campaigns/:id/events',
  [
    param('id').isInt().toInt(),
    body('items').isArray({ min: 1 }),
    body('items.*.contact_id').isInt().toInt(),
    body('items.*.event_type').isIn(['delivered','opened','clicked','bounced','complained','unsubscribed']),
    body('items.*.occurred_at').isISO8601(),
    body('items.*.meta').optional().isObject()
  ],
  asyncH(async (req, res) => {
    const { id } = req.params;
    const { items } = req.body;
    if (!items.length) return res.json({ inserted: 0 });
    const rows = items.map(e => [id, e.contact_id, e.event_type, e.occurred_at, JSON.stringify(e.meta || null)]);
    await pool.query(
      `INSERT INTO campaign_events (campaign_id, contact_id, event_type, occurred_at, meta_json)
       VALUES ?`, [rows]
    );
    // Aggiorna status recipient quando serve (aperto/click/unsub/bounce)
    await pool.query(`
      UPDATE campaign_recipients cr
      JOIN (
        SELECT contact_id,
               MAX(CASE WHEN event_type='opened' THEN 1 ELSE 0 END) opened,
               MAX(CASE WHEN event_type='clicked' THEN 1 ELSE 0 END) clicked,
               MAX(CASE WHEN event_type IN ('bounced','complained','unsubscribed') THEN event_type ELSE NULL END) neg
        FROM campaign_events
        WHERE campaign_id = ?
        GROUP BY contact_id
      ) e ON e.contact_id = cr.contact_id
      SET cr.send_status = IF(e.neg IS NOT NULL, e.neg, IF(e.clicked=1,'clicked', IF(e.opened=1,'opened', cr.send_status)))
      WHERE cr.campaign_id = ?`, [id, id]);
    res.json({ inserted: rows.length });
  })
);

module.exports = router;
