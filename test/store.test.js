// Runs the real store against an in-memory fake of the Google Sheet. No network.
//   node test/store.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cxo-'));
process.env.DAILY_CAP = '3';
process.env.DEDUPE_DAYS = '7';
process.env.REOPEN_MIN = '15';

const { today } = require('../src/util');
const TD = today();
const YD = today(new Date(Date.now() - 86400000));
const serial = (d) => Date.parse(d + 'T00:00:00Z') / 86400000 + 25569;   // how Sheets returns dates

// ---------------- fake sheets module ----------------
const tabs = {};
let failWrites = false, readHook = null;
const colN = (s) => s.split('').reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
function parse(range) {
  const [tab, a1] = range.split('!');
  const m = a1.match(/^([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$/);
  return { tab, c0: colN(m[1]), r0: m[2] ? +m[2] - 1 : 0, c1: m[3] ? colN(m[3]) : colN(m[1]), r1: m[4] ? +m[4] - 1 : Infinity };
}
// USER_ENTERED-ish: "'x" → text x, "yyyy-mm-dd[ hh:mm:ss]" → serial
function enter(v) {
  if (typeof v !== 'string') return v;
  if (v.startsWith("'")) return v.slice(1);
  const m = v.match(/^(\d{4}-\d{2}-\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?$/);
  if (m) return serial(m[1]) + (m[2] ? (+m[2] * 3600 + +m[3] * 60 + +m[4]) / 86400 : 0);
  return v;
}
const fake = {
  async read(range) {
    if (readHook) { const h = readHook; readHook = null; await h(); }
    const { tab, c0, r0, c1, r1 } = parse(range);
    const t = tabs[tab] || [];
    const out = t.slice(r0, r1 === Infinity ? undefined : r1 + 1).map((r) => (r || []).slice(c0, c1 + 1));
    while (out.length && out[out.length - 1].every((c) => c === '' || c == null)) out.pop();
    return out;
  },
  async batchWrite(data) {
    if (failWrites) throw new Error('quota');
    for (const { range, values } of data) {
      const { tab, c0, r0 } = parse(range);
      const t = (tabs[tab] = tabs[tab] || []);
      values.forEach((row, i) => { t[r0 + i] = t[r0 + i] || []; row.forEach((v, j) => { t[r0 + i][c0 + j] = enter(v); }); });
    }
  },
  async append(range, rows) {
    if (failWrites) throw new Error('quota');
    const { tab } = parse(range);
    const t = (tabs[tab] = tabs[tab] || []);
    let n = t.length; while (n && (!t[n - 1] || t[n - 1].every((c) => c === '' || c == null))) n--;
    rows.forEach((r, i) => { t[n + i] = r.map(enter); });
  },
  async clear(range) {
    const { tab, r0 } = parse(range);
    if (tabs[tab]) tabs[tab].length = Math.min(tabs[tab].length, r0);
  },
  async ensureTabs(names) { names.forEach((n) => { tabs[n] = tabs[n] || []; }); },
};
require.cache[require.resolve('../src/sheets')] = { id: 'sheets', filename: 'sheets', loaded: true, exports: fake };

function freshStore() {
  for (const m of ['../src/store', '../src/wal']) delete require.cache[require.resolve(m)];
  return require('../src/store');
}

const A1 = '9000000001', A2 = '9000000002';
tabs.Leads = [
  ['cx_phone', 'cx_name', 'mapped_agent_phone', 'agent_name', 'Date', 'status', 'sent_at'],
  [9811111111, 'Ravi',  A1, 'Agent One', serial(TD)],
  [9822222222, 'Sita',  A1, 'Agent One', serial(TD)],
  [9833333333, 'Gopal', A1, 'Agent One', serial(YD)],          // overdue
  [9844444444, 'Meena', A1, 'Agent One', serial(TD)],
  [9855555555, 'Kiran', A1, 'Agent One', serial(TD)],
  [9811111111, 'Ravi',  A2, 'Agent Two', serial(TD)],          // same customer, other agent
  [9866666666, 'Asha',  A2, 'Agent Two', '05/10/2099'],        // future, text date
  [9877777777, 'Old',   A2, 'Agent Two', serial(YD), 'SENT', serial(YD) + 0.5],
];
tabs.MsgTemplate = [['hdr'], ['Hi {{cx_name}}, {{agent_name}} here']];

(async () => {
  let store = freshStore();
  await store.init();
  const ag1 = '91' + A1, ag2 = '91' + A2;

  // ---- queue ----
  let q = store.buildQueue(ag1);
  assert.strictEqual(q.todayCount, 4); assert.strictEqual(q.overdueCount, 1);
  assert.strictEqual(q.agentName, 'Agent One');
  assert.strictEqual(store.buildQueue(ag2).todayCount, 1, 'future lead hidden');
  const ravi1 = q.today.find((l) => l.cxName === 'Ravi').id;
  const ravi2 = store.buildQueue(ag2).today[0].id;

  // ---- 20 simultaneous taps on the same lead → exactly one send ----
  const codes = await Promise.all(Array.from({ length: 20 }, () => Promise.resolve().then(() => store.markSend(ag1, ravi1).code)));
  assert.strictEqual(codes.filter((c) => c === 'ok').length, 1);
  assert.strictEqual(codes.filter((c) => c === 'reopen').length, 19, 'same agent within grace → reopen page, not a new send');
  assert.ok(store.markSend(ag1, ravi1).waLink.includes('Hi%20Ravi%2C%20Agent%20One'));

  // ---- other agent, same customer → blocked + hidden ----
  assert.strictEqual(store.buildQueue(ag2).todayCount, 0, 'Ravi hidden from agent two');
  assert.strictEqual(store.markSend(ag2, ravi2).code, 'dup');
  assert.strictEqual(store.markSend(ag2, ravi2).code, 'closed');

  // ---- wrong agent cannot send someone else's lead ----
  assert.strictEqual(store.markSend(ag2, q.today[1].id).code, 'not_found');

  // ---- sort the sheet before the flush: statuses must land on the right rows ----
  const [hdr, ...body] = tabs.Leads;
  tabs.Leads = [hdr, ...body.reverse()];
  console.log('flush:', await store.flush());
  const row = (name, ag) => tabs.Leads.find((r) => r[1] === name && String(r[2]) === ag);
  assert.strictEqual(row('Ravi', A1)[5], 'SENT');
  assert.strictEqual(row('Ravi', A2)[5], 'DUPLICATE');
  assert.ok(!row('Sita', A1)[5], 'untouched lead stays blank');
  assert.ok(tabs.Clicks.some((r) => r[1] === 'SEND_CLICK' && r[5] === 'Ravi'));

  // ---- a tap that lands while a reload is reading the sheet is not lost ----
  const sita = store.buildQueue(ag1).today.find((l) => l.cxName === 'Sita').id;
  readHook = async () => { assert.strictEqual(store.markSend(ag1, sita).code, 'ok'); };
  await store.reload();
  assert.ok(!store.buildQueue(ag1).today.some((l) => l.id === sita), 'Sita stays sent after reload');
  assert.strictEqual(store.buildQueue(ag1).sentToday, 2);

  // ---- daily cap (3) ----
  const meena = store.buildQueue(ag1).today.find((l) => l.cxName === 'Meena').id;
  const kiran = store.buildQueue(ag1).today.find((l) => l.cxName === 'Kiran').id;
  assert.strictEqual(store.markSend(ag1, meena).code, 'ok');
  assert.strictEqual(store.markSend(ag1, kiran).code, 'capped');
  assert.strictEqual(store.buildQueue(ag1).remaining, 0);

  // ---- sheet down + crash: the volume log brings everything back ----
  failWrites = true;
  console.log('flush while sheet down:', await store.flush());
  assert.ok(!row('Meena', A1)[5], 'not in sheet yet');
  failWrites = false;
  store = freshStore();                    // "restart" — memory gone, WAL replayed
  await store.init();
  assert.strictEqual(store.buildQueue(ag1).sentToday, 3, 'cap survives restart');
  assert.strictEqual(store.markSend(ag1, meena).code, 'already', 'no grace after restart → hard block');
  await store.flush();
  assert.strictEqual(row('Meena', A1)[5], 'SENT', 'replayed status reached the sheet');

  // ---- archive: yesterday's SENT moves out, ids still resolve ----
  console.log('archive:', await store.archive());
  assert.ok(tabs.Archive.some((r) => r[1] === 'Old'));
  assert.ok(!tabs.Leads.some((r) => r && r[1] === 'Old'));
  assert.strictEqual(store.buildQueue(ag1).overdueCount, 1, 'Gopal still pending after archive');

  console.log('\nALL STORE TESTS PASSED');
})().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
