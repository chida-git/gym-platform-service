const crypto = require('crypto');
const dayjs = require('dayjs');

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function makeQrToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function addDays(date, days) {
  return dayjs(date).add(days, 'day').toDate();
}

function now() { return new Date(); }

module.exports = { hashToken, makeQrToken, addDays, now };