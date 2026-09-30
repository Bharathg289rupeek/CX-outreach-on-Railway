require('dotenv').config();

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

let creds = {};
try { creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}'); }
catch (e) { console.error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON'); }
if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, '\n');

module.exports = {
  PORT: num(process.env.PORT, 3000),
  SHEET_ID: process.env.SHEET_ID,
  GOOGLE_CREDS: creds,
  APP_URL: (process.env.APP_URL || '').replace(/\/+$/, ''),
  DAILY_CAP: num(process.env.DAILY_CAP, 10),
  DEDUPE_DAYS: num(process.env.DEDUPE_DAYS, 7),
  FLUSH_MS: num(process.env.FLUSH_MS, 120000),   // sync Railway → sheet every 2 min
  RELOAD_MIN: num(process.env.RELOAD_MIN, 5),
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || '',
  TZ: 'Asia/Kolkata',

  GUPSHUP_API_KEY: process.env.GUPSHUP_API_KEY || '',
  GUPSHUP_SOURCE: process.env.GUPSHUP_SOURCE || '919167123820',
  GUPSHUP_APP: process.env.GUPSHUP_APP || '',
  TEMPLATE_ID: process.env.TEMPLATE_ID || '',
  NAME_FALLBACK: process.env.NAME_FALLBACK || 'there',
  BLAST_ENABLED: process.env.BLAST_ENABLED !== '0',
};
