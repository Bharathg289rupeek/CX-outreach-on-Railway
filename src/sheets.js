/******************************************************************
 * Sheet <-> Postgres sync. Everything is batched so one full cycle costs
 * ~3–5 Sheets API calls, far below the 60 req/min/user quota.
 *
 * Every SYNC cycle (default 2 min):
 *   1. batchGet  Leads!A2:G + MsgTemplate!A2           (1 read)
 *   2. upsert leads into Postgres (keyed by lead_key)
 *   3. write status/sent_at back to Leads!F:G          (1 write, only if changed)
 *   4. append new events to Clicks                     (1 write, only if any)
 *   5. every Nth cycle: rewrite Dashboard + AgentLinks (2 calls)
 ******************************************************************/
const { google } = require('googleapis');
const { pool, getTemplate, DAILY_CAP, CX_COOLDOWN_DAYS } = require('./db');
const { today, normPhone, parseSheetDate, parseSheetDateTime, leadKey, fmtIST, sign } = require('./util');

const SHEET_ID = process.env.SHEET_ID;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const T = { LEADS: 'Leads', TPL: 'MsgTemplate', CLICKS: 'Clicks', DASH: 'Dashboard', LINKS: 'AgentLinks', ARCHIVE: 'Archive' };

let _sheets = null;
function api() {
  if (_sheets) return _sheets;
  let raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
  if (!raw.trim()) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set');
  if (!raw.trim().startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
  const creds = JSON.parse(raw);
  creds.private_key = String(creds.private_key || '').replace(/\\n/g, '\n');
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  _sheets = google.sheets({ version: 'v4', auth });
  return _sheets;
}

// ---- single-flight lock so sync / archive never overlap ----
let busy = false;
async function exclusive(name, fn) {
  if (busy) { console.log(`[${name}] skipped — another sheet job is running`); return 'skipped'; }
  busy = true;
  const t0 = Date.now();
  try { const r = await fn(); console.log(`[${name}] ${r} (${Date.now() - t0} ms)`); return r; }
  catch (e) { console.error(`[${name}] FAILED`, e.message); throw e; }
  finally { busy = false; }
}

async function ensureTabs() {
  const meta = await api().spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'sheets.properties.title' });
  const have = new Set(meta.data.sheets.map(s => s.properties.title));
  const missing = Object.values(T).filter(t => !have.has(t));
  if (missing.length) {
    await api().spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: missing.map(title => ({ addSheet: { properties: { title } } })) }
    });
  }
  if (missing.includes(T.CLICKS)) {
    await api().spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${T.CLICKS}!A1:G1`, valueInputOption: 'RAW',
      requestBody: { values: [['timestamp', 'event', 'agent_phone', 'agent_name', 'cx_phone', 'cx_name', 'lead_id / detail']] }
    });
  }
  return missing.length ? `created tabs: ${missing.join(', ')}` : 'all tabs present';
}

// Sheet rows → deduped lead records. rowKeys[i] = lead_key for sheet row i (or null if invalid)
function parseRows(rows, sourceTab) {
  const byKey = new Map();
  const rowKeys = rows.map(r => {
    const cx = normPhone(r[0]), ag = normPhone(r[2]), d = parseSheetDate(r[4]);
    if (!cx || !ag || !d) return null;
    const key = leadKey(cx, ag, d);
    if (!byKey.has(key)) {
      const status = String(r[5] == null ? '' : r[5]).trim();
      const sentAt = parseSheetDateTime(r[6]);
      byKey.set(key, {
        lead_key: key, cx_phone: cx, cx_name: String(r[1] == null ? '' : r[1]).trim(),
        agent_phone: ag, agent_name: String(r[3] == null ? '' : r[3]).trim(), lead_date: d,
        status, sent_at: sentAt ? sentAt.toISOString() : null, source_tab: sourceTab
      });
    }
    return key;
  });
  return { records: [...byKey.values()], rowKeys };
}

// Upsert; DB status wins once set. Returns Map(lead_key → {status, sent_at})
async function upsertLeads(records) {
  const out = new Map();
  for (let i = 0; i < records.length; i += 2000) {
    const chunk = records.slice(i, i + 2000);
    const r = await pool.query(
      `INSERT INTO leads (lead_key, cx_phone, cx_name, agent_phone, agent_name, lead_date, status, sent_at, source_tab)
       SELECT x.lead_key, x.cx_phone, x.cx_name, x.agent_phone, x.agent_name, x.lead_date::date,
              NULLIF(x.status,''),
              CASE WHEN NULLIF(x.status,'') IS NULL THEN NULL
                   ELSE COALESCE(x.sent_at::timestamptz, (x.lead_date || ' 12:00+05:30')::timestamptz) END,
              x.source_tab
       FROM json_to_recordset($1::json) AS x(lead_key text, cx_phone text, cx_name text, agent_phone text,
            agent_name text, lead_date text, status text, sent_at text, source_tab text)
       ON CONFLICT (lead_key) DO UPDATE SET
         cx_name    = CASE WHEN EXCLUDED.cx_name    <> '' THEN EXCLUDED.cx_name    ELSE leads.cx_name END,
         agent_name = CASE WHEN EXCLUDED.agent_name <> '' THEN EXCLUDED.agent_name ELSE leads.agent_name END,
         status     = COALESCE(leads.status,  EXCLUDED.status),
         sent_at    = CASE WHEN leads.status IS NULL THEN EXCLUDED.sent_at ELSE leads.sent_at END,
         updated_at = now()
       RETURNING lead_key, status, sent_at`,
      [JSON.stringify(chunk)]
    );
    r.rows.forEach(x => out.set(x.lead_key, { status: x.status || '', sent_at: x.sent_at }));
  }
  return out;
}

async function dashboardRows() {
  const td = today();
  const r = await pool.query(
    `WITH agents AS (
       SELECT agent_phone, max(agent_name) FILTER (WHERE agent_name <> '') AS agent_name
       FROM leads WHERE status IS NULL OR lead_date >= $1::date - 45 GROUP BY agent_phone),
     pend AS (
       SELECT l.agent_phone,
         count(DISTINCT l.cx_phone) FILTER (WHERE l.lead_date =  $1::date) AS fresh_today,
         count(DISTINCT l.cx_phone) FILTER (WHERE l.lead_date <  $1::date) AS overdue
       FROM leads l
       WHERE l.status IS NULL AND l.lead_date <= $1::date
         AND NOT ($3::int > 0 AND EXISTS (SELECT 1 FROM leads s WHERE s.cx_phone = l.cx_phone
               AND s.status = 'SENT' AND s.sent_at > now() - make_interval(days => $3::int)))
       GROUP BY l.agent_phone),
     ev AS (
       SELECT agent_phone,
         count(*) FILTER (WHERE event = 'SEND_CLICK') AS sent_mtd,
         count(*) FILTER (WHERE event = 'APP_OPEN'  AND (ts AT TIME ZONE 'Asia/Kolkata')::date = $1::date) AS opens_today,
         bool_or(event = 'LINK_SENT' AND (ts AT TIME ZONE 'Asia/Kolkata')::date = $1::date) AS link_sent,
         max(ts) AS last_ts
       FROM events
       WHERE (ts AT TIME ZONE 'Asia/Kolkata')::date >= date_trunc('month', $1::date)::date
       GROUP BY agent_phone)
     SELECT a.agent_phone, COALESCE(a.agent_name,'') AS agent_name,
            COALESCE(p.fresh_today,0)::int AS fresh_today, COALESCE(p.overdue,0)::int AS overdue,
            COALESCE(d.sent_count,0)::int AS sent_today, COALESCE(e.sent_mtd,0)::int AS sent_mtd,
            GREATEST(0, $2::int - COALESCE(d.sent_count,0))::int AS remaining,
            COALESCE(e.link_sent,false) AS link_sent, COALESCE(e.opens_today,0)::int AS opens_today, e.last_ts
     FROM agents a
     LEFT JOIN pend p USING (agent_phone)
     LEFT JOIN agent_daily d ON d.agent_phone = a.agent_phone AND d.day = $1::date
     LEFT JOIN ev e ON e.agent_phone = a.agent_phone
     ORDER BY a.agent_phone`,
    [td, DAILY_CAP, CX_COOLDOWN_DAYS]
  );
  return r.rows;
}

function agentLink(phone) { return `${PUBLIC_URL}/?agent=${sign(phone)}`; }

let cycle = 0;
async function syncOnce({ forceReports = false } = {}) {
  return exclusive('sync', async () => {
    const s = api();
    // 1) one read for leads + template
    const got = await s.spreadsheets.values.batchGet({
      spreadsheetId: SHEET_ID, ranges: [`${T.LEADS}!A2:G`, `${T.TPL}!A2`],
      valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER'
    });
    const rows = got.data.valueRanges[0].values || [];
    const tpl = ((got.data.valueRanges[1].values || [[]])[0] || [])[0];
    if (tpl && String(tpl).trim()) {
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ('msg_template',$1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
         WHERE settings.value IS DISTINCT FROM EXCLUDED.value`, [String(tpl)]);
    }

    // 2) upsert
    const { records, rowKeys } = parseRows(rows, T.LEADS);
    const state = await upsertLeads(records);

    // 3) write back F:G only where DB differs from sheet
    const writes = [];
    let changed = false;
    const fg = rows.map((r, i) => {
      const key = rowKeys[i];
      const sheetF = String(r[5] == null ? '' : r[5]).trim();
      const sheetG = r[6] == null ? '' : r[6];
      if (!key || !state.has(key)) return [sheetF, sheetG];
      const st = state.get(key);
      if (st.status !== sheetF || (st.sent_at && sheetG === '')) changed = true;
      return [st.status, st.status && st.sent_at ? fmtIST(st.sent_at) : sheetG];
    });
    if (changed && fg.length) writes.push({ range: `${T.LEADS}!F2:G${fg.length + 1}`, values: fg });

    // 5) reports every Nth cycle (default: every 5th = ~10 min) or on demand
    const every = Number(process.env.REPORT_EVERY_N_SYNCS || 5);
    const doReports = forceReports || (cycle++ % every === 0);
    if (doReports) {
      const d = await dashboardRows();
      const dash = [['agent_phone', 'agent_name', 'fresh_today', 'overdue_pending', 'sent_today', 'sent_mtd',
        'remaining_today', 'link_sent_today', 'app_opens_today', 'last_activity', '', `Refreshed: ${fmtIST(new Date())}`]]
        .concat(d.map(x => ["'" + x.agent_phone, x.agent_name, x.fresh_today, x.overdue, x.sent_today, x.sent_mtd,
          x.remaining, x.link_sent ? 'Yes' : 'No', x.opens_today, fmtIST(x.last_ts), '', '']));
      const links = [['agent_phone', 'agent_name', 'leads_today', 'overdue_pending', 'link']]
        .concat(d.map(x => ({ x, n: Math.min(x.remaining, x.fresh_today + x.overdue) }))
          .filter(o => o.n > 0 || o.x.overdue > 0)
          .map(o => ["'" + o.x.agent_phone, o.x.agent_name, o.n, o.x.overdue, agentLink(o.x.agent_phone)]));
      await s.spreadsheets.values.batchClear({ spreadsheetId: SHEET_ID, requestBody: { ranges: [`${T.DASH}!A:L`, `${T.LINKS}!A:E`] } });
      writes.push({ range: `${T.DASH}!A1`, values: dash }, { range: `${T.LINKS}!A1`, values: links });
    }
    if (writes.length) {
      await s.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID, requestBody: { valueInputOption: 'USER_ENTERED', data: writes }
      });
    }

    // 4) append unsynced events to Clicks
    const ev = await pool.query(
      `SELECT id, ts, event, agent_phone, agent_name, cx_phone, cx_name, lead_id, detail
       FROM events WHERE synced = false ORDER BY id LIMIT 5000`);
    if (ev.rows.length) {
      await s.spreadsheets.values.append({
        spreadsheetId: SHEET_ID, range: `${T.CLICKS}!A:G`, valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: ev.rows.map(e => [fmtIST(e.ts), e.event, e.agent_phone ? "'" + e.agent_phone : '', e.agent_name || '',
            e.cx_phone ? "'" + e.cx_phone : '', e.cx_name || '', e.detail || (e.lead_id ? String(e.lead_id) : '')])
        }
      });
      await pool.query(`UPDATE events SET synced = true WHERE id = ANY($1::bigint[])`, [ev.rows.map(e => e.id)]);
    }
    return `rows=${rows.length} leads=${records.length} writeback=${changed} events=${ev.rows.length} reports=${doReports}`;
  });
}

// One-time: pull history (e.g. the Archive tab) into Postgres so the cooldown knows
// who was already messaged. Import only — never writes to that tab.
async function importTab(tab) {
  return exclusive('import:' + tab, async () => {
    const got = await api().spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: `${tab}!A2:G`,
      valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER'
    });
    const { records } = parseRows(got.data.values || [], tab);
    await upsertLeads(records);
    return `${records.length} leads imported from ${tab}`;
  });
}

// Nightly: move SENT/DUP_SKIPPED rows from before today out of Leads into Archive.
// Safe even while agents are using the app — nothing depends on row numbers anymore.
async function archiveOld() {
  return exclusive('archive', async () => {
    const s = api();
    const td = today();
    const got = await s.spreadsheets.values.batchGet({
      spreadsheetId: SHEET_ID, ranges: [`${T.LEADS}!A1:G`, `${T.ARCHIVE}!A1:A1`],
      valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER'
    });
    const all = got.data.valueRanges[0].values || [];
    if (all.length < 2) return '0 rows archived';
    const header = all[0].concat(Array(7).fill('')).slice(0, 7);
    const body = all.slice(1).map(r => r.concat(Array(7).fill('')).slice(0, 7));
    const keep = [], move = [];
    body.forEach(r => {
      if (r.every(v => v === '' || v == null)) return;                         // drop blank rows
      const st = String(r[5] || '').trim();
      const sentDay = r[6] !== '' ? fmtIST(parseSheetDateTime(r[6])).slice(0, 10) : '';
      const leadDay = parseSheetDate(r[4]);
      const old = (st === 'SENT' && sentDay && sentDay < td) || (st === 'DUP_SKIPPED' && leadDay && leadDay < td);
      (old ? move : keep).push(r);
    });
    if (!move.length) return '0 rows archived';
    const archEmpty = !(got.data.valueRanges[1].values || []).length;
    await s.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: `${T.ARCHIVE}!A:G`, valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: (archEmpty ? [header] : []).concat(move) }
    });
    // clear exactly the rows we read, then write survivors at the top
    await s.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${T.LEADS}!A2:G${all.length}` });
    if (keep.length) {
      await s.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: `${T.LEADS}!A2`, valueInputOption: 'USER_ENTERED', requestBody: { values: keep }
      });
    }
    return `${move.length} rows archived, ${keep.length} remain in Leads`;
  });
}

module.exports = { ensureTabs, syncOnce, importTab, archiveOld, dashboardRows, agentLink, _parseRows: parseRows, _upsertLeads: upsertLeads };
