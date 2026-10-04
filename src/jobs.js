const cfg = require('./config');
const sh = require('./sheets');
const store = require('./store');
const wal = require('./wal');
const mailer = require('./mailer');
const { today, nowStr, normPhone, cleanParam, sleep, sign } = require('./util');

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

// ------------------------------ link delivery ------------------------------
// Channel per agent comes from the Agents tab (WHATSAPP / EMAIL / BOTH / NONE),
// blank → DEFAULT_CHANNEL. From the Agents tab, EMAIL without an address falls back to
// WhatsApp (so the agent still gets the link). An explicit override (admin page / API)
// does exactly what was asked: email with no address is reported as a failure.
function channelsFor(phone, override) {
  const c = store.agentContact(phone);
  const ch = String(override || c.channel || 'WHATSAPP').toUpperCase();
  if (ch === 'NONE') return { list: [], email: c.email };
  const list = [];
  if (ch === 'WHATSAPP' || ch === 'BOTH') list.push('whatsapp');
  if (ch === 'EMAIL' || ch === 'BOTH') list.push(c.email || override ? 'email' : 'whatsapp');
  return { list: [...new Set(list)], email: c.email, fellBack: !override && (ch === 'EMAIL' || ch === 'BOTH') && !c.email };
}

async function deliver(a, via, email) {
  if (via === 'email') {
    if (!email) return { ok: false, err: 'no email for this agent in the Agents tab' };
    return mailer.sendLinkEmail(email, a, agentLink(a.phone));
  }
  if (!cfg.GUPSHUP_API_KEY || !cfg.TEMPLATE_ID) return { ok: false, err: 'GUPSHUP_API_KEY / TEMPLATE_ID not set' };
  return gupshupSend(a.phone, a.name);
}

// Send one agent their link on every channel they're set to; logs LINK_SENT / LINK_FAIL with the channel
async function sendLinkTo(a, { channel, email } = {}) {
  const c = channelsFor(a.phone, channel);
  const to = email || c.email;
  const list = email && String(channel || '').toUpperCase() === 'EMAIL' ? ['email'] : c.list;
  const results = [];
  for (const via of list) {
    const r = await deliver(a, via, to);
    const ref = via === 'email' ? `email ${to}` : (c.fellBack ? 'whatsapp (no email set)' : 'whatsapp');
    if (r.ok) store.logClick('LINK_SENT', a.phone, a.name, '', '', ref);
    else store.logClick('LINK_FAIL', a.phone, a.name, '', '', `${via}: ${r.err}`);
    results.push({ via, to: via === 'email' ? to : a.phone, ...r });
  }
  return results;
}

// blastDay is kept on the volume, so a restart / redeploy after 9:30 can't blast twice
let blasting = false;
async function sendAgentLinks(force = false) {
  if (!cfg.BLAST_ENABLED) return 'blast disabled (BLAST_ENABLED=0)';
  if (blasting) return 'blast already running';
  if (wal.getMeta('blastDay') === today() && !force) return 'already blasted today (add ?force=1 to resend)';
  blasting = true;
  try {
    await store.reload();   // pick up leads added this morning + Agents tab edits
    wal.setMeta('blastDay', today());
    const list = store.agentSummaries().filter((a) => a.remaining > 0 && a.todayCount + a.overdueCount > 0);
    const n = { whatsapp: 0, email: 0, fail: 0, skipped: 0 };
    await pool(list, 10, async (a) => {
      const res = await sendLinkTo(a);
      if (!res.length) n.skipped++;
      res.forEach((r) => (r.ok ? n[r.via]++ : n.fail++));
    });
    const msg = `${list.length} agents with leads: ${n.whatsapp} WhatsApp, ${n.email} email, ${n.fail} failed, ${n.skipped} set to NONE`;
    console.log('[blast]', msg);
    return msg;
  } finally { blasting = false; }
}

// Send the link to one agent now. ?channel=whatsapp|email|both overrides the Agents tab;
// ?email= sends to that address instead (handy for testing).
async function testSend(phoneRaw, { channel, email } = {}) {
  const p = normPhone(phoneRaw);
  if (!p) throw new Error('pass ?phone=98XXXXXXXX');
  const q = store.buildQueue(p);
  const a = { phone: p, name: store.agentName(p), todayCount: q.todayCount, overdueCount: q.overdueCount };
  const results = await sendLinkTo(a, { channel, email });
  return { agent: p, greetedAs: cleanParam(a.name, cfg.NAME_FALLBACK), appLink: agentLink(p), results };
}

// ------------------------------ AgentLinks tab ------------------------------
async function writeAgentLinks() {
  const rows = store.agentSummaries()
    .filter((a) => a.todayCount + a.overdueCount > 0)
    .map((a) => {
      const c = store.agentContact(a.phone);
      return ["'" + a.phone, a.name, Math.min(a.remaining, a.todayCount + a.overdueCount), a.overdueCount, agentLink(a.phone), c.channel, c.email];
    });
  await sh.clear('AgentLinks!A:G');
  await sh.batchWrite([{ range: `AgentLinks!A1:G${rows.length + 1}`, values: [['agent_phone', 'agent_name', 'leads_today', 'overdue_pending', 'link', 'link_channel', 'email'], ...rows] }]);
  return `${rows.length} agent links written`;
}

// ------------------------------ Dashboard tab ------------------------------
async function refreshDashboard() {
  const monthStart = today().slice(0, 7) + '-01';
  const rows = store.agentSummaries().map((a) => {
    const x = store.activity(a.phone);
    return ["'" + a.phone, a.name, a.todayCount, a.overdueCount, a.sentToday, x.sentMtd, a.remaining,
      x.linkVia || (x.linkFail ? 'FAILED' : 'No'), x.opens, x.last];
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

// Everything the admin page shows, from memory (no sheet reads)
function overview() {
  const agents = store.agentSummaries().map((a) => {
    const c = store.agentContact(a.phone), x = store.activity(a.phone);
    return { ...a, email: c.email, channel: c.channel, link: agentLink(a.phone), ...x };
  });
  const sum = (k) => agents.reduce((n, a) => n + (a[k] || 0), 0);
  const withLeads = agents.filter((a) => a.todayCount + a.overdueCount > 0);
  return {
    date: today(), now: nowStr(), cap: cfg.DAILY_CAP,
    totals: {
      agents: agents.length, agentsWithLeads: withLeads.length,
      leadsToday: sum('todayCount'), overdue: sum('overdueCount'), sentToday: sum('sentToday'), sentMtd: sum('sentMtd'),
      linksSent: agents.filter((a) => a.linkVia).length, linkFails: agents.filter((a) => a.linkFail).length,
      opened: agents.filter((a) => a.opens > 0).length,
    },
    channels: { whatsapp: !!(cfg.GUPSHUP_API_KEY && cfg.TEMPLATE_ID), email: mailer.emailEnabled() },
    blast: { enabled: cfg.BLAST_ENABLED, lastDay: wal.getMeta('blastDay') || '', ranToday: wal.getMeta('blastDay') === today() },
    system: store.stats(),
    agents,
  };
}

// Send links to a chosen set of agents (admin page). channel: whatsapp | email | both | '' (= Agents tab)
async function sendLinks(phones, { channel, email } = {}) {
  const want = new Set((phones || []).map(normPhone).filter(Boolean));
  const list = store.agentSummaries().filter((a) => want.has(a.phone));
  [...want].filter((p) => !list.some((a) => a.phone === p))
    .forEach((p) => list.push({ phone: p, name: store.agentName(p), todayCount: 0, overdueCount: 0 }));
  const results = [];
  await pool(list, 5, async (a) => {
    const res = await sendLinkTo(a, { channel, email });
    if (!res.length) results.push({ phone: a.phone, name: a.name, via: '-', ok: false, err: 'channel is NONE' });
    res.forEach((r) => results.push({ phone: a.phone, name: a.name, via: r.via, to: r.to, ok: r.ok, err: r.err || '' }));
  });
  return { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}

module.exports = { sendAgentLinks, testSend, sendLinks, writeAgentLinks, refreshDashboard, overview, agentLink };
