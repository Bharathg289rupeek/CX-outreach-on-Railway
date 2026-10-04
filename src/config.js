try { require('dotenv').config(); } catch (e) { /* dotenv is optional (local dev only) */ }

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

// Real line breaks inside "..." strings (what dashboards often do to the key's \n) → \n escapes
function escapeNewlinesInStrings(s) {
  let out = '', inStr = false, esc = false;
  for (const ch of s) {
    if (inStr && !esc && (ch === '\n' || ch === '\r')) { if (ch === '\n') out += '\\n'; continue; }
    out += ch;
    if (esc) esc = false;
    else if (ch === '\\') esc = inStr;
    else if (ch === '"') inStr = !inStr;
  }
  return out;
}

// GOOGLE_SERVICE_ACCOUNT_JSON: the whole key file — raw JSON (as pasted, even if the
// dashboard mangled line breaks or wrapped it in quotes) or base64 of it.
// Alternative: GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY as two separate variables.
function parseCreds(v) {
  let raw = String(v || '').trim();
  if (!raw) return {};
  if (/^'.*'$/s.test(raw)) raw = raw.slice(1, -1).trim();
  if (!raw.startsWith('{') && !raw.startsWith('"')) raw = Buffer.from(raw, 'base64').toString('utf8').trim();
  const attempts = [raw, escapeNewlinesInStrings(raw)];
  for (const a of attempts) {
    try {
      let j = JSON.parse(a);
      if (typeof j === 'string') j = JSON.parse(escapeNewlinesInStrings(j));   // value was JSON-quoted twice
      if (j && typeof j === 'object') return j;
    } catch (e) { /* try next */ }
  }
  let reason = '';
  try { JSON.parse(escapeNewlinesInStrings(raw)); } catch (e) { reason = e.message; }
  console.error(`GOOGLE_SERVICE_ACCOUNT_JSON could not be parsed (${raw.length} chars, starts with ${JSON.stringify(raw.slice(0, 1))}): ${reason}`);
  return {};
}

let creds = parseCreds(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
if (!creds.client_email && process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
  creds = { client_email: process.env.GOOGLE_CLIENT_EMAIL.trim(), private_key: process.env.GOOGLE_PRIVATE_KEY.trim().replace(/^"|"$/g, '') };
}
if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, '\n');
if (creds.client_email) console.log('[config] Google service account:', creds.client_email);

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

  // How agents get their daily link when the Agents tab doesn't say: WHATSAPP | EMAIL | BOTH | NONE
  DEFAULT_CHANNEL: String(process.env.DEFAULT_CHANNEL || 'WHATSAPP').toUpperCase(),
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: num(process.env.SMTP_PORT, 587),
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  MAIL_FROM: process.env.MAIL_FROM || '',
  // HTTPS mail relay (apps-script/mail-relay.gs) — use when the host blocks SMTP (Railway non-Pro)
  MAIL_RELAY_URL: (process.env.MAIL_RELAY_URL || '').trim(),
  MAIL_RELAY_SECRET: process.env.MAIL_RELAY_SECRET || '',
};
