// src/email/layout.js
const fs = require('fs');
const path = require('path');

const header = fs.readFileSync(path.join(__dirname, 'partials/header.html'), 'utf8');
const footer = fs.readFileSync(path.join(__dirname, 'partials/footer.html'), 'utf8');

function sanitizeInnerHtml(html = '') {
  // rimuove eventuali <html>/<body> dal template utente per evitare nidificazioni
  return String(html)
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<\/?html[^>]*>/gi, '')
    .replace(/<\/?head[^>]*>.*?<\/head>/gis, '')
    .replace(/<\/?body[^>]*>/gi, '');
}

function toText(html = '') {
  return sanitizeInnerHtml(html)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Ritorna HTML finale completo + versione testo.
 * @param {object} opts
 * @param {string} opts.subject
 * @param {string} opts.contentHtml - HTML del template o content_html
 * @param {string} [opts.unsubscribeUrl]
 * @param {string} [opts.webviewUrl]
 */
function renderEmail({ subject, contentHtml, unsubscribeUrl = '#', webviewUrl = '#' }) {
  const body = sanitizeInnerHtml(contentHtml || '');
  const h = header.replace('{{SUBJECT}}', subject || '');
  const f = footer
    .replace('{{UNSUB_LINK}}', unsubscribeUrl)
    .replace('{{WEBVIEW_LINK}}', webviewUrl);

  const outer = `
  <!doctype html>
  <html lang="it">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>${(subject || '').replace(/</g, '&lt;')}</title>
    </head>
    <body style="margin:0;padding:0;background:#ffffff;">
      ${h}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td align="center">
            <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;margin:0 auto;padding:20px 16px;">
              <tr><td style="font:400 15px/1.6 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
                ${body}
              </td></tr>
            </table>
          </td>
        </tr>
      </table>
      ${f}
    </body>
  </html>`.trim();

  return { html: outer, text: toText(outer) };
}

module.exports = { renderEmail };
