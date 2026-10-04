/******************************************************************
 * Agent link by email. Two transports:
 *  - MAIL_RELAY_URL (preferred on Railway): HTTPS POST to the Apps Script
 *    relay (apps-script/mail-relay.gs), which sends via MailApp from your
 *    Google account. Railway blocks outgoing SMTP on non-Pro plans.
 *  - SMTP_* : Gmail / Workspace App Password, SendGrid, AWS SES, etc.
 * Same content as the old Apps Script "CX Outreach Daily Email".
 ******************************************************************/
const nodemailer = require('nodemailer');
const cfg = require('./config');
const { today } = require('./util');

let _t = null;
function transport() {
  if (_t) return _t;
  _t = nodemailer.createTransport({
    host: cfg.SMTP_HOST, port: cfg.SMTP_PORT, secure: cfg.SMTP_PORT === 465,
    auth: { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS },
    pool: true, maxConnections: 3, rateDelta: 1000, rateLimit: 5,   // stay well under Gmail limits
  });
  return _t;
}

const relayEnabled = () => !!(cfg.MAIL_RELAY_URL && cfg.MAIL_RELAY_SECRET);
const smtpEnabled = () => !!(cfg.SMTP_HOST && cfg.SMTP_USER && cfg.SMTP_PASS);
const emailEnabled = () => relayEnabled() || smtpEnabled();
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function dateLabel() {
  const [y, m, d] = today().split('-');
  return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m - 1]} ${y}`;
}

function buildEmail(a, link) {
  const first = String(a.name || '').trim().split(/\s+/)[0] || 'Team';
  const cell = 'border:1px solid #ddd;padding:8px 14px;';
  const html =
    '<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;">' +
    `<p>Hi ${esc(first)},</p>` +
    `<p>Your customer outreach list for today is ready. You can send up to <b>${cfg.DAILY_CAP} messages</b> today.</p>` +
    '<table style="border-collapse:collapse;margin:12px 0;">' +
    `<tr><td style="${cell}">Daily Target</td><td style="${cell}font-weight:bold;">${cfg.DAILY_CAP} messages</td></tr>` +
    `<tr><td style="${cell}">Today's Leads</td><td style="${cell}font-weight:bold;">${a.todayCount}</td></tr>` +
    `<tr><td style="${cell}">Overdue / Pending</td><td style="${cell}font-weight:bold;color:#c0392b;">${a.overdueCount}</td></tr>` +
    '</table>' +
    '<p><b>Click the button below to send WhatsApp messages to your customers:</b></p>' +
    `<p style="margin:20px 0;"><a href="${esc(link)}" style="background:#25D366;color:#fff;padding:12px 28px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block;">📲 Send WhatsApp Messages</a></p>` +
    `<p style="font-size:12px;color:#888;">If the button doesn't work, copy this link into your browser:<br>${esc(link)}</p>` +
    '<p>Regards,<br>Rupeek CX Team</p></div>';
  const text = `Hi ${first},\n\nYour customer outreach list for today is ready (${a.todayCount} today, ${a.overdueCount} pending). ` +
    `You can send up to ${cfg.DAILY_CAP} messages today.\n\nOpen your list: ${link}\n\nRegards,\nRupeek CX Team`;
  return { subject: `CX Outreach : Today CX List — ${dateLabel()}`, html, text };
}

async function sendViaRelay(to, m) {
  const fromName = (String(cfg.MAIL_FROM).match(/^\s*"?([^"<]+?)"?\s*</) || [])[1] || 'Rupeek CX Team';
  try {
    // Apps Script answers a POST with a 302 to the result; fetch follows it with a GET
    const r = await fetch(cfg.MAIL_RELAY_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'follow',
      body: JSON.stringify({ secret: cfg.MAIL_RELAY_SECRET, to, fromName, ...m }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch (e) { /* HTML = sign-in page / wrong access setting */ }
    if (j && j.ok) return { ok: true, body: `relay, quota left ${j.quotaLeft}` };
    if (j) return { ok: false, err: 'relay: ' + j.err };
    return { ok: false, err: `relay returned HTTP ${r.status} non-JSON — set the web app's "Who has access" to Anyone and redeploy` };
  } catch (e) { return { ok: false, err: 'relay: ' + String(e.message || e).slice(0, 250) }; }
}

async function sendLinkEmail(to, a, link) {
  if (!emailEnabled()) return { ok: false, err: 'email not configured (MAIL_RELAY_URL + MAIL_RELAY_SECRET, or SMTP_HOST / SMTP_USER / SMTP_PASS)' };
  if (relayEnabled()) return sendViaRelay(to, buildEmail(a, link));
  try {
    const m = buildEmail(a, link);
    const info = await transport().sendMail({ from: cfg.MAIL_FROM || cfg.SMTP_USER, to, ...m });
    return { ok: true, body: info.messageId };
  } catch (e) { return { ok: false, err: String(e.message || e).slice(0, 300) }; }
}

module.exports = { sendLinkEmail, emailEnabled, buildEmail };
