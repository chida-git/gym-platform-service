// src/mailer.js
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT || 465,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

transporter.verify().then(() => {
  console.log('[mailer] SMTP ready');
}).catch(err => {
  console.error('[mailer] SMTP verify failed:', err.message);
});

async function sendMail({ to, subject, html, text, from_name, from_email }) {
  const fromAddr = from_email || process.env.SMTP_USER; // Aruba spesso richiede from = user
  const from = from_name ? `${from_name} <${fromAddr}>` : fromAddr;

  const info = await transporter.sendMail({
    from,
    to,
    subject,
    html,
    text,
    envelope: { from: fromAddr, to } // “MAIL FROM” effettivo = account Aruba
  });

  // 🔒 check “duro”: rifiuta se l’SMTP non ha accettato il destinatario
  const accepted = Array.isArray(info.accepted) ? info.accepted.length : 0;
  const rejected = Array.isArray(info.rejected) ? info.rejected.length : 0;

  if (accepted === 0 || rejected > 0) {
    const reason = `SMTP not accepted: accepted=${accepted}, rejected=${rejected}, response=${info.response || ''}`;
    const e = new Error(reason);
    e.smtpInfo = info;
    throw e;
  }

  return info;
}

module.exports = { sendMail };
