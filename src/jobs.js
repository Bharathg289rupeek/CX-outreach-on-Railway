const cfg = require('./config');
const sh = require('./sheets');
const store = require('./store');
const wal = require('./wal');
const { today, nowStr, normPhone, dstr, serialToStr, cleanParam, sleep, sign } = require('./util');

const agentLink = (p) => `${cfg.APP_URL}/?agent=${sign(p)}`;

// ------------------------------ Gupshup ------------------------------
// params = [body {{1}} = agent name, button URL {{1}} = agent param (phone, or phone.sig when LINK_SECRET is set)]
async function gupshupSend(phone, name) {
  const body = new URLSearchParams({
    channel: 'whatsapp',
    source: cfg.GUPSHUP_SOURCE,
    'src.name': cfg.GUPSHUP_APP,
    destination: phone,
    template: JSON.stringify({ id: cfg.TEMPLATE_ID, params: [cleanParam(name, cfg.NAME_FALLBACK), sign(phone)] }),
  });
  try {
    const r = await fetch('https://api.gupshup.io/wa/api/v1/template/msg', {
      method: 'POST',
      headers: { apikey: cfg.GUPSHUP_API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
      body, signal: AbortSignal.timeout(20000),
    });
    const text = await r.text();
    return r.ok ? { ok: true, body: text } : { ok: false, err: `HTTP ${r.status} ${text}`.slice(0, 300) };
  } catch (e) { return { ok: false, err: String(e.message || e).slice(0, 300) }; }
}

async function pool(items, size, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); await sleep(100); }
  });
  await Promise.all(workers);
}

// blastDay is kept on the volume, so a restart / redeploy after 9:30 can't blast twice
let blasting = false;
async function sendAgentLinks(force = false) {
  if (!cfg.BLAST_ENABLED) return 'blast disabled (BLAST_ENABLED=0)';
  if (!cfg.GUPSHUP_API_KEY || !cfg.TEMPLATE_ID) return 'GUPSHUP_API_KEY / TEMPLATE_ID not set';
  if (blasting) return 'blast already running';
  if (wal.getMeta('blastDay') === today() && !force) return 'already blasted today (add ?force=1 to resend)';
  blasting = true;
  try {
    await store.reload();   // pick up any leads added this morning
    wal.setMeta('blastDay', today());
    const list = store.agentSummaries().filter((a) => a.remaining > 0 && a.todayCount + a.overdueCount > 0);
    let ok = 0, fail = 0;
    await pool(list, 10, async (a) => {
      const r = await gupshupSend(a.phone, a.name);
      if (r.ok) { ok++; store.logClick('LINK_SENT', a.phone, a.name); }
      else { fail++; store.logClick('LINK_FAIL', a.phone, a.name, '', '', r.err); }
    });
    const msg = `${ok} sent, ${fail} failed (of ${list.length} agents with leads)`;
    console.log('[blast]', msg);
    return msg;
  } finally { blasting = false; }
}

async function testSend(phoneRaw) {
  const p = normPhone(phoneRaw);
  if (!p) throw new Error('pass ?phone=98XXXXXXXX');
  const name = store.agentName(p);
  const r = await gupshupSend(p, name);
  return { to: p, greetedAs: cleanParam(name, cfg.NAME_FALLBACK), appLink: agentLink(p), ...r };
}

// ------------------------------ AgentLinks tab ------------------------------
async function writeAgentLinks() {
  const rows = store.agentSummaries()
    .filter((a) => a.todayCount + a.overdueCount > 0)
    .map((a) => ["'" + a.phone, a.name, Math.min(a.remaining, a.todayCount + a.overdueCount), a.overdueCount, agentLink(a.phone)]);
  await sh.clear('AgentLinks!A:E');
  await sh.batchWrite([{ range: `AgentLinks!A1:E${rows.length + 1}`, values: [['agent_phone', 'agent_name', 'leads_today', 'overdue_pending', 'link'], ...rows] }]);
  return `${rows.length} agent links written`;
}

// ------------------------------ Dashboard tab ------------------------------
async function refreshDashboard() {
  const td = today();
  const monthStart = td.slice(0, 7) + '-01';
  const clicks = await sh.read('Clicks!A2:C');
  const meta = {};
  const m = (p) => (meta[p] = meta[p] || { opens: 0, linkSent: 0, sentMtd: 0, last: '' });

  clicks.forEach(([ts, ev, ag]) => {
    const p = normPhone(ag); if (!p) return;
    const d = dstr(ts), x = m(p);
    if (ev === 'APP_OPEN' && d === td) x.opens++;
    if (ev === 'LINK_SENT' && d === td) x.linkSent++;
    if (ev === 'SEND_CLICK' && d >= monthStart && d <= td) x.sentMtd++;
    const full = typeof ts === 'number' ? serialToStr(ts) : String(ts || '').slice(0, 16);
    if (full > x.last) x.last = full;
  });

  const rows = store.agentSummaries().map((a) => {
    const x = meta[a.phone] || m(a.phone);
    return ["'" + a.phone, a.name, a.todayCount, a.overdueCount, a.sentToday, x.sentMtd, a.remaining,
      x.linkSent ? 'Yes' : 'No', x.opens, x.last];
  });
  const header = ['agent_phone', 'agent_name', 'fresh_today', 'overdue_pending', 'sent_today', 'sent_mtd',
    'remaining_today', 'link_sent_today', 'app_opens_today', 'last_activity'];
  await sh.clear('Dashboard!A:L');
  await sh.batchWrite([
    { range: `Dashboard!A1:J${rows.length + 1}`, values: [header, ...rows] },
    { range: 'Dashboard!L1', values: [[`Refreshed: ${nowStr()} · MTD from ${monthStart}`]] },
  ]);
  return `${rows.length} agents on dashboard`;
}

module.exports = { sendAgentLinks, testSend, writeAgentLinks, refreshDashboard, agentLink };
