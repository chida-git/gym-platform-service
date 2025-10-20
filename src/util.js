const crypto = require('crypto');
const dayjs = require('dayjs');
function hashToken(token) { return crypto.createHash('sha256').update(token, 'utf8').digest('hex'); }
function makeQrToken() { return crypto.randomBytes(32).toString('base64url'); }
function addDays(date, days) { return dayjs(date).add(days, 'day').toDate(); }
function now() { return new Date(); }

/**
 * Estrae solo le chiavi specificate da un oggetto.
 * @param {Object} obj - L'oggetto sorgente
 * @param {string[]} keys - Lista di chiavi da mantenere
 * @returns {Object} - Nuovo oggetto con solo le chiavi desiderate
 */
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return {};
  const result = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      result[key] = obj[key];
    }
  }
  return result;
}

/**
 * Converte una stringa in uno slug URL-safe.
 * Esempio: "Corso di Zumba Avanzato" → "corso-di-zumba-avanzato"
 * @param {string} str - Stringa di input
 * @returns {string} slug normalizzato
 */
function toSlug(str) {
  if (!str) return '';
  return str
    .toString()
    .normalize('NFD')                    // separa accenti
    .replace(/[\u0300-\u036f]/g, '')     // rimuove diacritici
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')         // sostituisce non alfanumerici con -
    .replace(/^-+|-+$/g, '');            // rimuove - iniziali/finali
}

module.exports = { hashToken, makeQrToken, addDays, now, pick, toSlug };
