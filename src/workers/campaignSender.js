// src/workers/campaignSender.js
const { pool } = require('../db');
const { sendMail } = require('../mailer');
const { renderEmail } = require('../email/layout');

const PER_HOUR  = Number(process.env.MAILS_PER_HOUR || 100);
const BATCH     = Number(process.env.MAIL_BATCH_SIZE || 50);
const TICK_MS   = Number(process.env.SENDER_TICK_MS || 60000);

/** Conta quante email sono state spedite negli ultimi 60 minuti (globale). */
async function sentInLastHour() {
  const [[row]] = await pool.query(`
    SELECT COUNT(*) AS c
    FROM campaign_recipients
    WHERE send_status='sent' AND send_at > (NOW() - INTERVAL 1 HOUR)
  `);
  return Number(row.c || 0);
}

/** Prende una campagna in coda da processare. Priorità: ready -> scheduled scadute -> sending */
async function pickCampaign() {
  // ready
  let [rows] = await pool.query(`
    SELECT id FROM newsletter_campaigns 
    WHERE status='ready' 
    ORDER BY id ASC LIMIT 1
  `);
  if (rows.length) return rows[0].id;

  // scheduled (pronte temporalmente)
  [rows] = await pool.query(`
    SELECT id FROM newsletter_campaigns 
    WHERE status='scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= NOW()
    ORDER BY scheduled_at ASC LIMIT 1
  `);
  if (rows.length) return rows[0].id;

  // sending (prosegui gli invii rimasti)
  [rows] = await pool.query(`
    SELECT id FROM newsletter_campaigns 
    WHERE status='sending'
    ORDER BY updated_at ASC LIMIT 1
  `);
  if (rows.length) return rows[0].id;

  return null;
}

/** Invia un batch per una specifica campagna (rispetta quota oraria). */
async function sendBatchForCampaign(campaignId, quotaAllowed) {
  // recupero contenuti
  const [[camp]] = await pool.query(`
    SELECT c.*, t.html AS tpl_html, t.subject AS tpl_subject
    FROM newsletter_campaigns c
    LEFT JOIN newsletter_templates t ON t.id = c.template_id
    WHERE c.id=?`, [campaignId]);
  if (!camp) return { sent:0, failed:0, remaining:0 };
  console.log(".1")
  // destinatari queued
  const [recipients] = await pool.query(`
    SELECT mc.id AS contact_id, u.email
    FROM campaign_recipients cr
    JOIN marketing_contacts mc ON mc.id = cr.contact_id
    JOIN users u ON u.id = mc.user_id
    WHERE cr.campaign_id = ? AND cr.send_status='queued'
    ORDER BY cr.id ASC
    LIMIT ?`, [campaignId, quotaAllowed]
  );
    console.log(".campaignId", campaignId)
      console.log(".quotaAllowed", quotaAllowed)
  console.log(".2")
  if (!recipients.length) {
    // nulla da inviare: se non ci sono più queued → chiudi campagna
    const [[remain]] = await pool.query(`
      SELECT COUNT(*) AS queued_remaining
      FROM campaign_recipients WHERE campaign_id=? AND send_status='queued'`, [campaignId]);
    if (Number(remain.queued_remaining) === 0 && camp.status !== 'sent') {
      await pool.query(`UPDATE newsletter_campaigns SET status='sent', sent_at=NOW() WHERE id=?`, [campaignId]);
    }
    return { sent:0, failed:0, remaining:0 };
  }
  console.log(".3")
  // assicura stato "sending"
  if (camp.status !== 'sending') {
    await pool.query(`UPDATE newsletter_campaigns SET status='sending', updated_at=NOW() WHERE id=?`, [campaignId]);
  }

  const innerHtml = camp.content_html || camp.tpl_html || '';
  const subject = camp.subject || camp.tpl_subject || '(senza oggetto)';

  const { html, text } = renderEmail({
  subject,
  contentHtml: innerHtml,
  unsubscribeUrl: 'https://gymspot.it/unsub?c=' + r.contact_id, // esempio
  webviewUrl: 'https://gymspot.it/campaign/' + campaignId + '/view'
});

  let sent = 0, failed = 0;
  for (const r of recipients) {
    try {
      await sendMail({ to: r.email, subject, html, text: html.replace(/<[^>]+>/g, '') });
      await pool.query(`
        UPDATE campaign_recipients 
        SET send_status='sent', send_at=NOW(), last_error=NULL
        WHERE campaign_id=? AND contact_id=?`, [campaignId, r.contact_id]);
      sent++;
    } catch (e) {
      await pool.query(`
        UPDATE campaign_recipients 
        SET send_status='failed', last_error=?
        WHERE campaign_id=? AND contact_id=?`, [String(e.message).slice(0,490), campaignId, r.contact_id]);
      failed++;
    }
  }

  const [[remain]] = await pool.query(`
    SELECT COUNT(*) AS queued_remaining
    FROM campaign_recipients WHERE campaign_id=? AND send_status='queued'`, [campaignId]);

  if (Number(remain.queued_remaining) === 0) {
    await pool.query(`UPDATE newsletter_campaigns SET status='sent', sent_at=NOW() WHERE id=?`, [campaignId]);
  } else {
    await pool.query(`UPDATE newsletter_campaigns SET updated_at=NOW() WHERE id=?`, [campaignId]);
  }

  return { sent, failed, remaining: Number(remain.queued_remaining) };
}

/** Loop principale */
async function tick() {
  try {
    console.log("start")
    // quota oraria residua
    const used = await sentInLastHour();
    const remainingWindow = Math.max(0, PER_HOUR - used);
    if (remainingWindow <= 0) return; // rate-limited: aspetto prossimo tick
    console.log(remainingWindow)
    // prendo una campagna da lavorare
    const cid = await pickCampaign();
    if (!cid) return;

    const take = Math.min(remainingWindow, BATCH);
    await sendBatchForCampaign(cid, take);
  } catch (e) {
    // log non-bloccante
    console.error('[campaignSender tick error]', e.message);
  }
}

/** Avvio */
function startCampaignSender() {
  // primo giro dopo 5s, poi ogni TICK_MS
  setTimeout(() => { tick(); }, 5000);
  setInterval(() => { tick(); }, TICK_MS);
  console.log(`[campaignSender] running every ${TICK_MS}ms, limit ${PER_HOUR}/h, batch ${BATCH}`);
}

module.exports = { startCampaignSender };
