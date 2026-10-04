const crypto = require('crypto');

const TZ = 'Asia/Kolkata';
const IST_OFFSET_MS = 330 * 60000;

const pad = (n) => String(n).padStart(2, '0');

// Date → parts in IST, independent of the server's own timezone (Railway runs UTC)
function istParts(d = new Date()) {
  const t = new Date(d.getTime() + IST_OFFSET_MS);
  return { y: t.getUTCFullYear(), m: pad(t.getUTCMonth() + 1), d: pad(t.getUTCDate()),
           H: pad(t.getUTCHours()), M: pad(t.getUTCMinutes()), S: pad(t.getUTCSeconds()) };
}

// 'yyyy-MM-dd' in IST
function today(d = new Date()) { const p = istParts(d); return `${p.y}-${p.m}-${p.d}`; }

// 'yyyy-MM-dd HH:mm:ss' in IST (the sheet parses this as a real date-time)
function nowStr(d = new Date()) { const p = istParts(d); return `${p.y}-${p.m}-${p.d} ${p.H}:${p.M}:${p.S}`; }

// 10-digit numbers get 91 prefixed; anything else keeps its digits (same rule as the Apps Script)
function normPhone(v) {
  let d = String(v == null ? '' : v).replace(/\D/g, '');
  if (d.length === 10) d = '91' + d;
  return d;
}

// Sheets serial number (days since 1899-12-30, in the sheet's own timezone) → 'yyyy-MM-dd HH:mm'
function serialToStr(v) {
  const t = new Date(Math.round((Number(v) - 25569) * 86400000));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
}

// Any sheet date cell → 'yyyy-MM-dd' ('' if unreadable). Handles serial numbers,
// yyyy-mm-dd[ HH:mm], and Indian day-first dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy.
function dstr(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number' && isFinite(v)) return serialToStr(v).slice(0, 10);
  if (v instanceof Date) return today(v);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return '';
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// whole days from a to b ('yyyy-MM-dd' strings)
function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

// Meta rejects template params that are empty or contain newlines, tabs, or 4+ spaces
function cleanParam(v, fallback) {
  const s = String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return s || fallback;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- signed agent links: ?agent=<phone>.<sig> (only when LINK_SECRET is set) ----
function sign(phone) {
  const secret = process.env.LINK_SECRET;
  if (!secret) return phone;
  return phone + '.' + crypto.createHmac('sha256', secret).update(phone).digest('hex').slice(0, 12);
}

// ?agent= value → normalized phone, or '' if the link is not acceptable
function verifyAgent(param) {
  const [p, sig] = String(param || '').trim().split('.');
  const phone = normPhone(p);
  if (!phone || !process.env.LINK_SECRET) return phone;
  if (sig) {
    const a = Buffer.from(sig), b = Buffer.from(sign(phone).split('.')[1]);
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? phone : '';
  }
  return process.env.REQUIRE_SIGNED_LINKS === 'true' ? '' : phone;   // unsigned: allowed during cutover
}

module.exports = { TZ, today, nowStr, normPhone, serialToStr, dstr, isDate, daysBetween, cleanParam, sleep, sign, verifyAgent };
