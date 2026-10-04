/******************************************************************
 * Admin dashboard (/admin) — Rupeek-branded, server-rendered shell; data
 * comes from /admin/api/overview (all in memory, no sheet reads).
 * Send agent links by WhatsApp / email per agent or in bulk, run the blast,
 * and sync / reload / archive the sheet.
 ******************************************************************/
const LOGO = 'data:image/png;base64,' + require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'logo-sm.png')).toString('base64');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
:root{--grad:linear-gradient(90deg,#DF3C27 0%,#B9266B 50%,#2964A6 100%);--red:#E05227;--magenta:#B9266B;--blue:#2964A6;
  --gold:#C98208;--cream:#FCF3E8;--ink:#2B1B1E;--muted:#7a6a66;--line:#eadccd;--card:#fff;--ok:#1f8a4c;--okbg:#e3f4ea;--bad:#c0392b;--badbg:#fbe5e1;--wa:#25d366}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--cream);color:var(--ink);font-size:14px}
header{background:var(--grad);color:#fff;padding:12px 20px;display:flex;align-items:center;gap:12px;position:sticky;top:0;z-index:20}
header img{height:34px;width:34px;border-radius:50%;background:#fff;padding:3px;object-fit:contain}
header h1{font-size:17px;margin:0}
header .sub{font-size:12.5px;opacity:.9}
header .sp{flex:1}
header a{color:#fff;font-size:13px;text-decoration:none;border:1px solid rgba(255,255,255,.6);padding:6px 12px;border-radius:8px}
main{max-width:1280px;margin:0 auto;padding:16px}
.strip{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
.pill{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:5px 12px;font-size:12.5px;display:flex;gap:6px;align-items:center}
.dot{width:8px;height:8px;border-radius:50%;background:#bbb;flex:none}.dot.ok{background:var(--ok)}.dot.bad{background:var(--bad)}.dot.warn{background:var(--gold)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px}
.kpi{background:var(--card);border-radius:12px;padding:12px 14px;box-shadow:0 1px 3px rgba(43,27,30,.07)}
.kpi .l{font-size:12px;color:var(--muted)}.kpi .v{font-size:24px;font-weight:700;margin-top:2px;font-variant-numeric:tabular-nums}
.kpi .s{font-size:11.5px;color:var(--muted);margin-top:2px}.kpi.gold .v{color:var(--gold)}
.panel{background:var(--card);border-radius:12px;box-shadow:0 1px 3px rgba(43,27,30,.07);padding:14px;margin-bottom:14px}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.panel h2{font-size:14px;margin:0 0 10px}
button,.btn{font:inherit;border:none;border-radius:8px;padding:8px 13px;font-weight:600;cursor:pointer;background:#f1e5d6;color:var(--ink);white-space:nowrap}
button:disabled{opacity:.45;cursor:not-allowed}
.primary{background:var(--red);color:#fff}.grad{background:var(--grad);color:#fff}
.wa{background:var(--wa);color:#fff}.mail{background:var(--blue);color:#fff}
.sm{padding:5px 9px;font-size:12.5px}
input,select{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink)}
input[type=search]{min-width:220px;flex:1}
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;min-width:1050px}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
th{background:#fbf6ef;font-size:12px;color:var(--muted);font-weight:600;position:sticky;top:0;cursor:pointer;user-select:none}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
tr:hover td{background:#fffaf4}
.nm{font-weight:600}.ph{color:var(--muted);font-size:12px}
.badge{display:inline-block;border-radius:6px;padding:2px 7px;font-size:11.5px;font-weight:700}
.b-ok{background:var(--okbg);color:var(--ok)}.b-bad{background:var(--badbg);color:var(--bad)}.b-no{background:#f1ece6;color:var(--muted)}
.b-ch{background:#efe7f6;color:var(--magenta)}.b-gold{background:#fbeed6;color:var(--gold)}
.bar{height:6px;background:#f1e5d6;border-radius:4px;overflow:hidden;width:70px;display:inline-block;vertical-align:middle;margin-left:6px}
.bar i{display:block;height:100%;background:var(--grad)}
.acts{display:flex;gap:5px}
.muted{color:var(--muted)}
#toast{position:fixed;right:16px;bottom:16px;max-width:420px;background:var(--ink);color:#fff;border-radius:10px;padding:12px 14px;font-size:13px;display:none;z-index:50;box-shadow:0 4px 16px rgba(0,0,0,.25);white-space:pre-line}
dialog{border:none;border-radius:14px;padding:0;max-width:640px;width:calc(100% - 32px);box-shadow:0 10px 40px rgba(0,0,0,.3)}
dialog .hd{background:var(--grad);color:#fff;padding:12px 16px;font-weight:700}
dialog .bd{padding:14px 16px;max-height:60vh;overflow:auto}
dialog .ft{padding:10px 16px;text-align:right;border-top:1px solid var(--line)}
.login{max-width:380px;margin:80px auto;background:#fff;border-radius:14px;padding:26px;box-shadow:0 1px 3px rgba(43,27,30,.08)}
.login input{width:100%;margin:10px 0 14px}.login button{width:100%}
.err{color:var(--bad);font-size:13px}
@media (max-width:640px){main{padding:10px}header{padding:10px 12px}input[type=search]{min-width:0}}
`;

function shell(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><link rel="icon" href="${LOGO}"><style>${CSS}</style></head><body>${body}</body></html>`;
}

function loginPage(error) {
  return shell('CX Outreach Admin', `
<header><img src="${LOGO}" alt="Rupeek"><div><h1>CX Outreach Admin</h1><div class="sub">Sign in</div></div></header>
<form class="login" method="post" action="/admin/login">
  <b>Admin token</b>
  <input name="token" type="password" autocomplete="current-password" autofocus required>
  ${error ? `<div class="err">${esc(error)}</div><br>` : ''}
  <button class="primary" type="submit">Sign in</button>
</form>`);
}

function dashboardPage() {
  return shell('CX Outreach Admin', `
<header><img src="${LOGO}" alt="Rupeek"><div><h1>CX Outreach Admin</h1><div class="sub" id="sub">Loading…</div></div>
<div class="sp"></div><a href="/admin/logout">Sign out</a></header>
<main>
  <div class="strip" id="strip"></div>
  <div class="kpis" id="kpis"></div>

  <div class="panel">
    <h2>Daily agent links</h2>
    <div class="row">
      <button class="grad" id="blastBtn" onclick="blast()">Send today's links to all agents</button>
      <span class="muted" id="blastInfo"></span>
      <span class="sp" style="flex:1"></span>
      <button class="sm" onclick="op('flush','Push pending clicks to the sheet')">Sync to sheet</button>
      <button class="sm" onclick="op('reload','Re-read Leads, template and Agents tab')">Reload sheet</button>
      <button class="sm" onclick="op('reports','Rewrite Dashboard and AgentLinks tabs')">Refresh tabs</button>
      <button class="sm" onclick="op('archive','Move sent leads from before today to Archive',true)">Archive</button>
    </div>
  </div>

  <div class="panel">
    <div class="row" style="margin-bottom:10px">
      <input type="search" id="q" placeholder="Search name, phone or email" oninput="draw()">
      <select id="flt" onchange="draw()">
        <option value="leads">Agents with leads</option>
        <option value="all">All agents</option>
        <option value="nolink">Link not sent today</option>
        <option value="fail">Link failed</option>
        <option value="unopened">Link sent, not opened</option>
        <option value="capped">Daily limit reached</option>
        <option value="email">Has email</option>
      </select>
      <span class="sp" style="flex:1"></span>
      <select id="bulkCh" title="Channel for selected agents">
        <option value="">As set in Agents tab</option>
        <option value="whatsapp">WhatsApp</option>
        <option value="email">Email</option>
        <option value="both">WhatsApp + Email</option>
      </select>
      <button class="primary" id="bulkBtn" onclick="sendSelected()" disabled>Send link to selected (0)</button>
    </div>
    <div class="tablewrap"><table>
      <thead><tr>
        <th style="width:30px"><input type="checkbox" id="all" onclick="toggleAll(this.checked)"></th>
        <th data-k="name">Agent</th><th data-k="channel">Link via</th>
        <th class="n" data-k="todayCount">Today</th><th class="n" data-k="overdueCount">Overdue</th>
        <th class="n" data-k="sentToday">Sent today</th><th class="n" data-k="sentMtd">MTD</th>
        <th data-k="linkVia">Link today</th><th class="n" data-k="opens">Opens</th><th data-k="last">Last activity</th>
        <th>Send link</th>
      </tr></thead>
      <tbody id="rows"><tr><td colspan="11" class="muted">Loading…</td></tr></tbody>
    </table></div>
    <div class="muted" style="margin-top:8px;font-size:12px">Email and channel per agent are edited in the sheet's <b>Agents</b> tab (picked up within 5 min, or press <i>Reload sheet</i>).</div>
  </div>
</main>

<dialog id="dlg"><div class="hd" id="dlgT"></div><div class="bd" id="dlgB"></div><div class="ft"><button onclick="dlg.close()">Close</button></div></dialog>
<div id="toast"></div>

<script>
let D = null, SEL = new Set(), SORT = { k: 'name', dir: 1 };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (n) => Number(n || 0).toLocaleString('en-IN');

async function api(path, opt = {}) {
  const r = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opt });
  if (r.status === 401) { location.href = '/admin'; throw new Error('signed out'); }
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch (e) { j = t; }
  if (!r.ok) throw new Error(typeof j === 'string' ? j : JSON.stringify(j));
  return j;
}
function toast(msg, ms = 4000) { const t = $('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', ms); }

async function load() {
  try { D = await api('/admin/api/overview'); render(); }
  catch (e) { toast('Could not load: ' + e.message); }
}

function render() {
  const T = D.totals, S = D.system;
  $('sub').textContent = D.date + ' · updated ' + D.now.slice(11, 16);
  const pill = (cls, txt) => '<span class="pill"><span class="dot ' + cls + '"></span>' + txt + '</span>';
  const flushAgo = S.lastFlushAt ? Math.round((Date.now() - new Date(S.lastFlushAt)) / 60000) + ' min ago' : 'not yet';
  $('strip').innerHTML =
    pill(D.channels.whatsapp ? 'ok' : 'bad', 'WhatsApp ' + (D.channels.whatsapp ? 'ready' : 'not configured')) +
    pill(D.channels.email ? 'ok' : 'warn', 'Email ' + (D.channels.email ? 'ready' : 'not configured')) +
    pill(D.blast.ranToday ? 'ok' : (D.blast.enabled ? 'warn' : 'bad'), D.blast.ranToday ? '9:30 blast done today' : (D.blast.enabled ? '9:30 blast pending' : 'Auto blast OFF')) +
    pill(S.lastFlushError ? 'bad' : 'ok', 'Sheet sync ' + flushAgo + (S.lastFlushError ? ' — ERROR: ' + esc(S.lastFlushError) : '')) +
    pill(S.queuedStatuses + S.queuedClicks ? 'warn' : 'ok', (S.queuedStatuses + S.queuedClicks) + ' changes waiting for sheet') +
    pill(S.wal.durable ? 'ok' : 'bad', S.wal.durable ? 'Volume OK' : 'NO VOLUME — clicks lost on restart');
  const capTotal = T.agentsWithLeads * D.cap;
  const k = (l, v, s, cls) => '<div class="kpi ' + (cls || '') + '"><div class="l">' + l + '</div><div class="v">' + v + '</div><div class="s">' + (s || '') + '</div></div>';
  $('kpis').innerHTML =
    k('Agents with leads', fmt(T.agentsWithLeads), fmt(T.agents) + ' agents in total') +
    k('Leads today', fmt(T.leadsToday), fmt(T.overdue) + ' overdue pending') +
    k('Messages sent today', fmt(T.sentToday), capTotal ? Math.round(100 * T.sentToday / capTotal) + '% of ' + fmt(capTotal) + ' capacity' : '', 'gold') +
    k('Sent this month', fmt(T.sentMtd), 'all agents') +
    k('Links delivered', fmt(T.linksSent) + ' / ' + fmt(T.agentsWithLeads), T.linkFails ? '<span style="color:#c0392b">' + T.linkFails + ' failed</span>' : 'no failures') +
    k('Agents opened app', fmt(T.opened), T.linksSent ? Math.round(100 * T.opened / Math.max(1, T.linksSent)) + '% of links delivered' : '');
  $('blastBtn').textContent = D.blast.ranToday ? "Resend today's links to all agents" : "Send today's links to all agents";
  $('blastInfo').textContent = D.blast.ranToday ? 'Already sent today' + (D.blast.enabled ? '' : ' · auto blast is OFF') : (D.blast.enabled ? 'Auto-sends at 9:30 AM' : 'Auto blast is OFF (BLAST_ENABLED=0)');
  draw();
}

function rowsView() {
  const q = $('q').value.trim().toLowerCase(), f = $('flt').value;
  let a = D.agents.filter((x) => {
    const leads = x.todayCount + x.overdueCount > 0;
    if (f === 'leads' && !leads) return false;
    if (f === 'nolink' && (x.linkVia || !leads)) return false;
    if (f === 'fail' && !x.linkFail) return false;
    if (f === 'unopened' && !(x.linkVia && !x.opens)) return false;
    if (f === 'capped' && x.remaining > 0) return false;
    if (f === 'email' && !x.email) return false;
    return !q || (x.name + ' ' + x.phone + ' ' + x.email).toLowerCase().includes(q);
  });
  const k = SORT.k;
  return a.sort((x, y) => (x[k] > y[k] ? 1 : x[k] < y[k] ? -1 : 0) * SORT.dir);
}

function chBadge(x) {
  const c = (x.channel || 'WHATSAPP').toUpperCase();
  const label = { WHATSAPP: 'WhatsApp', EMAIL: 'Email', BOTH: 'Both', NONE: 'None' }[c] || c;
  const warn = (c === 'EMAIL' || c === 'BOTH') && !x.email ? ' <span class="badge b-bad" title="No email in Agents tab — will use WhatsApp">no email</span>' : '';
  return '<span class="badge b-ch">' + label + '</span>' + warn + (x.email ? '<div class="ph">' + esc(x.email) + '</div>' : '');
}
function linkBadge(x) {
  if (x.linkVia) return '<span class="badge b-ok">' + esc(x.linkVia) + '</span>';
  if (x.linkFail) return '<span class="badge b-bad" title="' + esc(x.linkFail) + '">FAILED</span>';
  return '<span class="badge b-no">Not sent</span>';
}

function draw() {
  const rows = rowsView();
  $('rows').innerHTML = rows.length ? rows.map((x) => {
    const pct = Math.min(100, Math.round(100 * x.sentToday / D.cap));
    return '<tr>' +
      '<td><input type="checkbox" ' + (SEL.has(x.phone) ? 'checked' : '') + ' onclick="sel(\\'' + x.phone + '\\',this.checked)"></td>' +
      '<td><div class="nm">' + esc(x.name || '—') + '</div><div class="ph">+' + esc(x.phone) + '</div></td>' +
      '<td>' + chBadge(x) + '</td>' +
      '<td class="n">' + x.todayCount + '</td><td class="n">' + x.overdueCount + '</td>' +
      '<td class="n">' + x.sentToday + '/' + D.cap + '<span class="bar"><i style="width:' + pct + '%"></i></span></td>' +
      '<td class="n">' + x.sentMtd + '</td>' +
      '<td>' + linkBadge(x) + '</td><td class="n">' + x.opens + '</td>' +
      '<td class="ph">' + esc(x.last || '—') + '</td>' +
      '<td><div class="acts">' +
        '<button class="sm wa" onclick="sendOne(\\'' + x.phone + '\\',\\'whatsapp\\')" ' + (D.channels.whatsapp ? '' : 'disabled') + '>WhatsApp</button>' +
        '<button class="sm mail" onclick="sendOne(\\'' + x.phone + '\\',\\'email\\')" ' + (D.channels.email ? '' : 'disabled title="Set SMTP_* variables first"') + '>Email</button>' +
        '<button class="sm" title="Copy app link" onclick="copyLink(\\'' + x.phone + '\\')">Copy link</button>' +
      '</div></td></tr>';
  }).join('') : '<tr><td colspan="11" class="muted">No agents match.</td></tr>';
  $('all').checked = rows.length > 0 && rows.every((x) => SEL.has(x.phone));
  $('bulkBtn').textContent = 'Send link to selected (' + SEL.size + ')';
  $('bulkBtn').disabled = !SEL.size;
}

function sel(p, on) { on ? SEL.add(p) : SEL.delete(p); draw(); }
function toggleAll(on) { rowsView().forEach((x) => on ? SEL.add(x.phone) : SEL.delete(x.phone)); draw(); }
document.querySelectorAll('th[data-k]').forEach((th) => th.onclick = () => {
  const k = th.dataset.k; SORT = { k, dir: SORT.k === k ? -SORT.dir : (['name','channel','linkVia','last'].includes(k) ? 1 : -1) }; draw();
});
const agent = (p) => D.agents.find((x) => x.phone === p) || { phone: p, name: '' };

function copyLink(p) {
  const l = agent(p).link;
  (navigator.clipboard ? navigator.clipboard.writeText(l) : Promise.reject()).then(() => toast('Link copied:\\n' + l), () => prompt('Copy this link:', l));
}

async function sendOne(p, channel) {
  const a = agent(p);
  let email = '';
  if (channel === 'email' && !a.email) {
    email = (prompt('No email for ' + (a.name || p) + ' in the Agents tab.\\nSend their link to this address:', '') || '').trim();
    if (!email) return;
  }
  const to = channel === 'email' ? (email || a.email) : '+' + p;
  if (!confirm('Send ' + (a.name || p) + "'s link by " + (channel === 'email' ? 'email' : 'WhatsApp') + ' to ' + to + '?')) return;
  await doSend([p], channel, email);
}

async function sendSelected() {
  const ch = $('bulkCh').value;
  const how = { '': 'their Agents-tab channel', whatsapp: 'WhatsApp', email: 'email', both: 'WhatsApp + email' }[ch];
  if (!confirm('Send links to ' + SEL.size + ' agent(s) by ' + how + '?')) return;
  await doSend([...SEL], ch, '');
}

async function doSend(phones, channel, email) {
  $('bulkBtn').disabled = true; toast('Sending to ' + phones.length + ' agent(s)…', 60000);
  try {
    const r = await api('/admin/api/send', { method: 'POST', body: JSON.stringify({ phones, channel, email }) });
    showResults('Sent ' + r.sent + ', failed ' + r.failed, r.results);
    if (phones.length > 1) SEL.clear();
    await load();
  } catch (e) { toast('Send failed: ' + e.message, 8000); }
}

function showResults(title, list) {
  $('toast').style.display = 'none';
  $('dlgT').textContent = title;
  $('dlgB').innerHTML = '<table style="min-width:0"><tr><th>Agent</th><th>Via</th><th>To</th><th>Result</th></tr>' +
    list.map((r) => '<tr><td>' + esc(r.name || r.phone) + '</td><td>' + esc(r.via) + '</td><td class="ph">' + esc(r.to || '') + '</td><td>' +
      (r.ok ? '<span class="badge b-ok">Sent</span>' : '<span class="badge b-bad">Failed</span> <span class="ph">' + esc(r.err) + '</span>') + '</td></tr>').join('') + '</table>';
  $('dlg').showModal();
}

async function blast() {
  const force = D.blast.ranToday;
  const n = D.totals.agentsWithLeads;
  if (!confirm((force ? 'Links were already sent today. RESEND' : 'Send') + " today's links to all " + n + ' agents with leads (each on their Agents-tab channel)?')) return;
  toast('Sending to all agents… this can take a few minutes.', 600000);
  try { const r = await api('/admin/blast' + (force ? '?force=1' : ''), { method: 'POST' }); toast(String(r), 10000); await load(); }
  catch (e) { toast('Blast failed: ' + e.message, 10000); }
}

async function op(name, what, confirmFirst) {
  if (confirmFirst && !confirm(what + '?')) return;
  toast(what + '…', 60000);
  try { const r = await api('/admin/' + name, { method: 'POST' }); toast(typeof r === 'string' ? r : JSON.stringify(r), 6000); await load(); }
  catch (e) { toast(name + ' failed: ' + e.message, 8000); }
}

load();
setInterval(() => { if (!document.hidden && !$('dlg').open) load(); }, 60000);
</script>`);
}

module.exports = { loginPage, dashboardPage };
