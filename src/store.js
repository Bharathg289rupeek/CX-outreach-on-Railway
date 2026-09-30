/******************************************************************
 * STORE — why this fixes the "same customer messaged twice" problem
 *
 * Apps Script version: every tap fired google.script.run.markSent() in the
 * background. Under load that call fails (concurrency limit / LockService
 * timeout / WhatsApp killing the page as it opens), the sheet never says SENT,
 * the lead comes back on the next open, and the customer gets it again.
 *
 * Here:
 *  1. All leads live in memory; the Node process is the single source of truth.
 *     A send is claimed synchronously (no await between check and set), so two
 *     taps can never both win — even across devices / agents.
 *  2. The tap itself hits the server (/s/:leadId). The lead is marked SENT
 *     BEFORE WhatsApp is opened, so a killed page can't lose the click.
 *  3. Every click / open / status is written to a log file on the Railway
 *     volume first (wal.js), then synced to the sheet every FLUSH_MS (2 min)
 *     in one batch. Failed syncs stay in the file and retry; a restart
 *     replays the file, so nothing is lost.
 *  4. Leads are addressed by a stable lead_id (column H), not row number,
 *     so sorting / inserting / archiving can't make a write land on the wrong row.
 *  5. Customer-level dedupe: a cx phone already messaged in the last
 *     DEDUPE_DAYS is blocked, even if it's duplicated in the Leads sheet.
 *
 * Run exactly ONE Railway replica — state is in memory.
 ******************************************************************/
const crypto = require('crypto');
const cfg = require('./config');
const sh = require('./sheets');
const wal = require('./wal');
const { normPhone, today, nowStr, dstr, isDate, daysBetween } = require('./util');

const LEADS = 'Leads', CLICKS = 'Clicks', ARCHIVE = 'Archive', TPL = 'MsgTemplate';
const LEAD_HEADER = ['cx_phone', 'cx_name', 'mapped_agent_phone', 'agent_name', 'Date', 'status', 'sent_at', 'lead_id'];
const CLICK_HEADER = ['timestamp', 'event', 'agent_phone', 'agent_name', 'cx_phone', 'cx_name', 'lead_id'];

const DEFAULT_TPL =
`Hi {{cx_name}}, this is {{agent_name}} from Rupeek Gold Loan.
Gold price is dipping, but Rupeek is giving the SAME loan amount at DROPPED interest rates! 📉✨
New reduced monthly rates:
- ₹0–3L: 1.34% ➜ 1.14% (−0.20%)
- ₹3–6L: 1.19% ➜ 0.99% (−0.20%)
- ₹6–12L: 1.04% ➜ 0.89% (−0.15%)
- ₹12L+: 0.94% ➜ 0.79% (−0.15%)
- ₹25L+: 0.89% ➜ 0.75% (−0.14%)
Lock in today's rate before prices move. WhatsApp me or call me!`;

// ------------------------------ state ------------------------------
const S = {
  leads: new Map(),      // lead_id → lead
  byAgent: new Map(),    // agent phone → [lead_id]
  agentNames: new Map(), // agent phone → name
  recentCx: new Map(),   // cx phone → last SENT date (yyyy-MM-dd), for dedupe
  sentCount: new Map(),  // agent phone → sends today
  countDay: '',
  template: DEFAULT_TPL,
  ready: false,
  loadedAt: null,
  lastFlushAt: null,
  lastFlushError: null,
};
const Q = { status: new Map(), clicks: [] };   // write-behind queue
const MAX_QUEUED_CLICKS = 50000;

// Serialize everything that touches the sheet (flush / reload / archive)
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

const newId = () => crypto.randomBytes(6).toString('hex');

function sentToday(agent) {
  const td = today();
  if (S.countDay !== td) { S.sentCount.clear(); S.countDay = td; }
  return S.sentCount.get(agent) || 0;
}

function isRecentCx(cx) {
  if (!cfg.DEDUPE_DAYS || !cx) return false;
  const last = S.recentCx.get(cx);
  return !!last && daysBetween(last, today()) < cfg.DEDUPE_DAYS;
}

function noteCxSent(cx, dateStr) {
  if (!cx || !isDate(dateStr)) return;
  const prev = S.recentCx.get(cx);
  if (!prev || dateStr > prev) S.recentCx.set(cx, dateStr);
}

function pruneRecentCx() {
  if (!cfg.DEDUPE_DAYS) { S.recentCx.clear(); return; }
  const td = today();
  for (const [cx, d] of S.recentCx) if (daysBetween(d, td) >= cfg.DEDUPE_DAYS) S.recentCx.delete(cx);
}

// ------------------------------ loading ------------------------------
async function loadLeads() {
  const rows = await sh.read(`${LEADS}!A1:H`);
  const td = today();
  const header = rows[0] || [];
  const writes = [];
  if (String(header[7] || '').trim() !== 'lead_id') {
    writes.push({ range: `${LEADS}!A1:H1`, values: [LEAD_HEADER] });
  }

  const leads = new Map(), byAgent = new Map(), names = new Map(), counts = new Map();
  const hcol = [];
  let idsChanged = false;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const empty = r.every((c) => c === '' || c == null);
    let id = String(r[7] == null ? '' : r[7]).trim();
    if (empty) { hcol.push([id]); continue; }
    if (!id || leads.has(id)) { id = newId(); idsChanged = true; }   // missing or copy-pasted duplicate id
    hcol.push([id]);

    const lead = {
      id,
      cxPhone: normPhone(r[0]),
      cxName: String(r[1] == null ? '' : r[1]).trim(),
      agentPhone: normPhone(r[2]),
      agentName: String(r[3] == null ? '' : r[3]).trim(),
      date: dstr(r[4]),
      status: String(r[5] == null ? '' : r[5]).trim(),
      sentAt: dstr(r[6]),
    };
    const q = Q.status.get(id);            // unflushed in-memory change wins over the sheet
    if (q) { lead.status = q.status; lead.sentAt = dstr(q.sentAt); }

    leads.set(id, lead);
    if (!lead.agentPhone) continue;
    if (!byAgent.has(lead.agentPhone)) byAgent.set(lead.agentPhone, []);
    byAgent.get(lead.agentPhone).push(id);
    if (lead.agentName && !names.has(lead.agentPhone)) names.set(lead.agentPhone, lead.agentName);

    if (lead.status === 'SENT') {
      noteCxSent(lead.cxPhone, lead.sentAt);
      if (lead.sentAt === td) counts.set(lead.agentPhone, (counts.get(lead.agentPhone) || 0) + 1);
    }
  }

  if (idsChanged && hcol.length) writes.push({ range: `${LEADS}!H2:H${hcol.length + 1}`, values: hcol });
  await sh.batchWrite(writes);

  // swap in atomically
  S.leads = leads; S.byAgent = byAgent; S.agentNames = names;
  S.sentCount = counts; S.countDay = td;
  S.loadedAt = new Date();
  pruneRecentCx();
  return leads.size;
}

async function loadTemplate() {
  try {
    const v = await sh.read(`${TPL}!A2`, { valueRenderOption: 'FORMATTED_VALUE' });
    const t = String((v[0] && v[0][0]) || '').trim();
    S.template = t || DEFAULT_TPL;
  } catch (e) { console.warn('[store] template read failed, keeping previous'); }
}

// Archive history for customer-level dedupe (startup only; archive can be big)
async function loadArchiveDedupe() {
  if (!cfg.DEDUPE_DAYS) return;
  try {
    const rows = await sh.read(`${ARCHIVE}!A2:G`);
    rows.forEach((r) => { if (String(r[5] || '').trim() === 'SENT') noteCxSent(normPhone(r[0]), dstr(r[6])); });
    pruneRecentCx();
  } catch (e) { console.warn('[store] archive dedupe read failed:', e.message); }
}

async function ensureHeaders() {
  const c = await sh.read(`${CLICKS}!A1:G1`);
  if (!c.length) await sh.batchWrite([{ range: `${CLICKS}!A1:G1`, values: [CLICK_HEADER] }]);
  const t = await sh.read(`${TPL}!A1:A2`);
  if (!t.length) await sh.batchWrite([{ range: `${TPL}!A1:A2`, values: [['CX message template — edit A2. Placeholders: {{cx_name}}, {{agent_name}}'], [DEFAULT_TPL]] }]);
}

async function init() {
  wal.load(Q);
  await sh.ensureTabs([LEADS, CLICKS, ARCHIVE, TPL, 'Dashboard', 'AgentLinks']);
  await ensureHeaders();
  await loadArchiveDedupe();
  const n = await loadLeads();
  await loadTemplate();
  S.ready = true;
  console.log(`[store] ready — ${n} leads, ${S.byAgent.size} agents, ${S.recentCx.size} recent customers`);
}

// flush pending writes, then pull the sheet again (picks up newly added leads)
function reload() {
  return serial(async () => {
    const n = await loadLeads();   // pending (unsynced) statuses still override the sheet
    await loadTemplate();
    return `${n} leads, ${S.byAgent.size} agents`;
  });
}

// ------------------------------ queue ------------------------------
function logClick(event, agentPhone, agentName, cxPhone = '', cxName = '', ref = '') {
  if (Q.clicks.length >= MAX_QUEUED_CLICKS) Q.clicks.shift();
  const row = [
    nowStr(), event,
    agentPhone ? "'" + agentPhone : '',
    agentName || S.agentNames.get(agentPhone) || '',
    cxPhone ? "'" + cxPhone : '',
    cxName || '',
    ref ? "'" + String(ref) : '',
  ];
  Q.clicks.push(row);
  wal.append({ t: 'click', row });
}

function setStatus(lead, status) {
  const at = nowStr();
  lead.status = status;
  lead.sentAt = at.slice(0, 10);
  Q.status.set(lead.id, { status, sentAt: at });
  wal.append({ t: 'status', id: lead.id, status, sentAt: at });
}

function flush() { return serial(doFlush); }

async function doFlush() {
  if (!Q.status.size && !Q.clicks.length) return 'nothing to flush';
  const statuses = new Map(Q.status);
  const clicks = Q.clicks.splice(0, Q.clicks.length);
  let wrote = 0, errors = [];

  if (statuses.size) {
    try {
      // fresh id→row map every flush: rows can move (manual sort/insert/archive)
      const col = await sh.read(`${LEADS}!H1:H`, { valueRenderOption: 'FORMATTED_VALUE' });
      const rowOf = new Map();
      col.forEach((r, i) => { const v = String((r && r[0]) || '').trim(); if (v) rowOf.set(v, i + 1); });
      const data = [];
      for (const [id, v] of statuses) {
        const row = rowOf.get(id);
        if (!row) { console.warn('[flush] lead_id not found in sheet, dropping:', id); continue; }
        data.push({ range: `${LEADS}!F${row}:G${row}`, values: [[v.status, v.sentAt]] });
      }
      await sh.batchWrite(data);
      for (const [id, v] of statuses) if (Q.status.get(id) === v) Q.status.delete(id);
      wrote = data.length;
    } catch (e) { errors.push('status: ' + e.message); }   // stays queued → retried next flush
  }

  if (clicks.length) {
    try { await sh.append(`${CLICKS}!A:G`, clicks); }
    catch (e) { Q.clicks.unshift(...clicks); errors.push('clicks: ' + e.message); }
  }

  wal.compact(Q);   // drop what reached the sheet, keep what didn't
  S.lastFlushAt = new Date();
  S.lastFlushError = errors.length ? errors.join(' | ') : null;
  if (errors.length) console.error('[flush] will retry —', S.lastFlushError);
  return `${wrote} statuses, ${errors.length ? 0 : clicks.length} clicks written`;
}

// ------------------------------ reads for UI ------------------------------
function renderMsg(lead) {
  return S.template
    .replace(/\{\{\s*cx_name\s*\}\}/g, lead.cxName || 'Customer')
    .replace(/\{\{\s*agent_name\s*\}\}/g, S.agentNames.get(lead.agentPhone) || 'Rupeek');
}
const waLink = (lead) => 'https://wa.me/' + lead.cxPhone + '?text=' + encodeURIComponent(renderMsg(lead));

function buildQueue(agent) {
  const td = today();
  const overdue = [], todayL = [], seen = new Set();
  for (const id of S.byAgent.get(agent) || []) {
    const L = S.leads.get(id);
    if (!L || L.status || !L.cxPhone || !isDate(L.date) || L.date > td) continue;
    if (seen.has(L.cxPhone) || isRecentCx(L.cxPhone)) continue;   // never show a customer twice
    seen.add(L.cxPhone);
    const item = { id: L.id, cxName: L.cxName, cxPhone: L.cxPhone, origDate: L.date };
    (L.date < td ? overdue : todayL).push(item);
  }
  overdue.sort((a, b) => (a.origDate < b.origDate ? -1 : a.origDate > b.origDate ? 1 : 0));
  const sent = sentToday(agent);
  return {
    agentName: S.agentNames.get(agent) || '',
    sentToday: sent, remaining: Math.max(0, cfg.DAILY_CAP - sent), cap: cfg.DAILY_CAP,
    today: todayL, overdue, todayCount: todayL.length, overdueCount: overdue.length, date: td,
  };
}

function agentSummaries() {
  return [...S.byAgent.keys()].sort().map((p) => {
    const q = buildQueue(p);
    return { phone: p, name: q.agentName, todayCount: q.todayCount, overdueCount: q.overdueCount, sentToday: q.sentToday, remaining: q.remaining };
  });
}

// ------------------------------ the send claim ------------------------------
// Fully synchronous: Node runs this to completion before handling any other
// request, so the check-then-set can't race. This is the duplicate-send fix.
function markSend(agent, id) {
  const L = S.leads.get(id);
  if (!L || !agent || L.agentPhone !== agent) return { code: 'not_found' };

  if (L.status === 'SENT') {
    logClick('REPEAT_BLOCKED', agent, '', L.cxPhone, L.cxName, id);
    return { code: 'already', lead: L };
  }
  if (L.status) return { code: 'closed', lead: L };

  if (isRecentCx(L.cxPhone)) {
    setStatus(L, 'DUPLICATE');
    logClick('DUP_BLOCKED', agent, '', L.cxPhone, L.cxName, id);
    return { code: 'dup', lead: L, lastSent: S.recentCx.get(L.cxPhone) };
  }

  if (sentToday(agent) >= cfg.DAILY_CAP) return { code: 'capped', lead: L };

  setStatus(L, 'SENT');
  S.sentCount.set(agent, sentToday(agent) + 1);
  noteCxSent(L.cxPhone, today());
  logClick('SEND_CLICK', agent, '', L.cxPhone, L.cxName, id);
  return { code: 'ok', lead: L, waLink: waLink(L) };
}

// ------------------------------ archive ------------------------------
// Moves SENT/DUPLICATE rows finished before today to Archive. Because rows are
// addressed by lead_id, this no longer corrupts writes if an agent is mid-session.
function archive() {
  return serial(async () => {
    await doFlush();
    const td = today();
    const raw = await sh.read(`${LEADS}!A1:H`);                                        // for decisions
    const fmt = await sh.read(`${LEADS}!A1:H`, { valueRenderOption: 'FORMATTED_VALUE' }); // for rewriting as-displayed
    if (raw.length < 2) return '0 rows archived';
    if (raw.length !== fmt.length) throw new Error('Leads changed during archive — retry');

    const width = LEAD_HEADER.length;
    const padRow = (r) => { const x = (r || []).slice(0, width); while (x.length < width) x.push(''); return x; };
    const keep = [LEAD_HEADER], move = [];
    for (let i = 1; i < raw.length; i++) {
      const r = raw[i] || [];
      if (r.every((c) => c === '' || c == null)) continue;   // compact blank rows
      const st = String(r[5] || '').trim();
      const sa = dstr(r[6]);
      const done = (st === 'SENT' || st === 'DUPLICATE') && isDate(sa) && sa < td;
      (done ? move : keep).push(padRow(fmt[i]));
    }
    if (!move.length) return '0 rows archived';

    const ah = await sh.read(`${ARCHIVE}!A1:H1`);
    if (!ah.length) await sh.batchWrite([{ range: `${ARCHIVE}!A1:H1`, values: [LEAD_HEADER] }]);
    await sh.append(`${ARCHIVE}!A:H`, move);                                             // 1) copy out
    await sh.batchWrite([{ range: `${LEADS}!A1:H${keep.length}`, values: keep }]);        // 2) overwrite top
    await sh.clear(`${LEADS}!A${keep.length + 1}:H`);                                    // 3) clear the tail
    await loadLeads();
    return `${move.length} rows archived, ${keep.length - 1} remain in Leads`;
  });
}

function stats() {
  return {
    ready: S.ready, leads: S.leads.size, agents: S.byAgent.size,
    queuedStatuses: Q.status.size, queuedClicks: Q.clicks.length,
    loadedAt: S.loadedAt, lastFlushAt: S.lastFlushAt, lastFlushError: S.lastFlushError,
    flushEverySec: Math.round(cfg.FLUSH_MS / 1000), wal: wal.info(),
  };
}

module.exports = {
  init, reload, flush, archive, buildQueue, agentSummaries, markSend, logClick, stats,
  ready: () => S.ready, agentName: (p) => S.agentNames.get(p) || '',
};
