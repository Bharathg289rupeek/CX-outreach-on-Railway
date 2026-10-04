try { require('dotenv').config(); } catch (e) { /* dotenv is optional (local dev only) */ }

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

// GOOGLE_SERVICE_ACCOUNT_JSON: the whole key file, as raw JSON or base64 of it
let creds = {};
try {
  let raw = String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  if (raw && !raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
  creds = raw ? JSON.parse(raw) : {};
} catch (e) { console.error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON / base64 JSON'); }
if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, '\n');

module.exports = {
  PORT: num(process.env.PORT, 3000),
  SHEET_ID: process.env.SHEET_ID,
  GOOGLE_CREDS: creds,
  APP_URL: (process.env.APP_URL || process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  DAILY_CAP: num(process.env.DAILY_CAP, 10),
  DEDUPE_DAYS: num(process.env.DEDUPE_DAYS, 7),          // same customer not messaged again by ANY agent within N days (0 = off)
  FLUSH_MS: num(process.env.FLUSH_MS, 120000),           // Railway → sheet every 2 min
  RELOAD_MIN: num(process.env.RELOAD_MIN, 5),            // sheet → Railway (new leads, template edits)
  REPORT_MIN: num(process.env.REPORT_MIN, 10),           // Dashboard + AgentLinks refresh
  REOPEN_MIN: num(process.env.REOPEN_MIN, 15),           // agent may re-open WhatsApp for a lead they just sent
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || '',
  RUN_CRONS: process.env.RUN_CRONS !== 'false',
  TZ: 'Asia/Kolkata',

  GUPSHUP_API_KEY: process.env.GUPSHUP_API_KEY || '',
  GUPSHUP_SOURCE: process.env.GUPSHUP_SOURCE || '919167123820',
  GUPSHUP_APP: process.env.GUPSHUP_APP || '',
  TEMPLATE_ID: process.env.TEMPLATE_ID || '',
  NAME_FALLBACK: process.env.NAME_FALLBACK || 'there',
  BLAST_ENABLED: process.env.BLAST_ENABLED !== '0',
};
