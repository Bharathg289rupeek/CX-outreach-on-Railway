const crypto = require('crypto');

const TZ = 'Asia/Kolkata';

// 'yyyy-MM-dd' in IST
function today(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// 10-digit numbers get 91 prefixed; anything else keeps its digits (same rule as the Apps Script)
function normPhone(v) {
  let d = String(v == null ? '' : v).replace(/\D/g, '');
  if (d.length === 10) d = '91' + d;
  return d;
}

// Sheet date cell → 'yyyy-MM-dd'. Handles serial numbers (UNFORMATTED_VALUE),
// yyyy-mm-dd, dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy. Returns '' if unreadable.
function parseSheetDate(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number' && isFinite(v)) {
    const ms = Math.round((v - 25569) * 86400000);   // Sheets epoch 1899-12-30
    return new Date(ms).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);   // Indian format: day first
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}

// Sheet timestamp cell → JS Date (or null)
function parseSheetDateTime(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && isFinite(v)) {
    // Serial in sheet's timezone (IST); convert to UTC
    return new Date(Math.round((v - 25569) * 86400000) - 330 * 60000);
  }
  const d = parseSheetDate(v);
  if (!d) return null;
  const t = String(v).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  const hh = t ? t[1].padStart(2, '0') : '00', mm = t ? t[2] : '00', ss = t && t[3] ? t[3] : '00';
  return new Date(`${d}T${hh}:${mm}:${ss}+05:30`);
}

function leadKey(cxPhone, agentPhone, dateStr) {
  return crypto.createHash('sha1').update(`${cxPhone}|${agentPhone}|${dateStr}`).digest('hex');
}

// Remove characters Meta rejects in template params
function cleanParam(v, fallback) {
  const s = String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return s || fallback;
}

// ---- signed agent links: ?agent=<phone>.<sig> ----
function sign(phone) {
  const secret = process.env.LINK_SECRET;
  if (!secret) return phone;
  const sig = crypto.createHmac('sha256', secret).update(phone).digest('hex').slice(0, 12);
  return `${phone}.${sig}`;
}

// Returns the normalized phone if the param is acceptable, else ''
function verifyAgentParam(param) {
  const raw = String(param || '').trim();
  const [p, sig] = raw.split('.');
  const phone = normPhone(p);
  if (!phone) return '';
  if (!process.env.LINK_SECRET) return phone;
  if (sig) {
    const good = sign(phone).split('.')[1];
    const a = Buffer.from(sig), b = Buffer.from(good);
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? phone : '';
  }
  // unsigned link: only allowed during migration
  return process.env.REQUIRE_SIGNED_LINKS === 'true' ? '' : phone;
}

function fmtIST(d) {
  if (!d) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date(d)).replace(',', '');
}

module.exports = { TZ, today, normPhone, parseSheetDate, parseSheetDateTime, leadKey, cleanParam, sign, verifyAgentParam, fmtIST };
