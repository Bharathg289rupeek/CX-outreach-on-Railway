/******************************************************************
 * WAL — events are stored on Railway FIRST, then synced to the sheet.
 *
 * Every click / app open / SENT status is appended to a file on the Railway
 * volume (DATA_DIR/pending.jsonl) BEFORE the request is answered. Every
 * FLUSH_MS (default 2 min) the queue is written to Google Sheets; whatever
 * succeeded is removed from the file, whatever failed stays for next time.
 *
 * On restart / redeploy / crash the file is replayed, so nothing is lost and
 * leads already sent stay blocked even if they never reached the sheet.
 ******************************************************************/
const fs = require('fs');
const path = require('path');

let DIR = process.env.DATA_DIR || '/data';
let FILE = '';
let durable = true;

function ensureDir() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.accessSync(DIR, fs.constants.W_OK);
  } catch (e) {
    // no volume mounted → still works, but events only survive in memory
    DIR = path.join(__dirname, '..', 'data');
    fs.mkdirSync(DIR, { recursive: true });
    durable = false;
    console.warn(`[wal] DATA_DIR not writable — using ${DIR}. Attach a Railway volume at /data so events survive redeploys.`);
  }
  FILE = path.join(DIR, 'pending.jsonl');
}

// Append one event. Sync on purpose: it's on disk before we respond.
function append(entry) {
  try { fs.appendFileSync(FILE, JSON.stringify(entry) + '\n'); }
  catch (e) { console.error('[wal] append failed:', e.message); }
}

// Rebuild the pending queue from disk (startup)
function load(Q) {
  ensureDir();
  if (!fs.existsSync(FILE)) return 0;
  let n = 0;
  const lines = fs.readFileSync(FILE, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.t === 'click') Q.clicks.push(e.row);
      else if (e.t === 'status') Q.status.set(e.id, { status: e.status, sentAt: e.sentAt });
      n++;
    } catch (err) { /* half-written last line after a crash — skip it */ }
  }
  console.log(`[wal] replayed ${n} pending events (${Q.status.size} statuses, ${Q.clicks.length} clicks) from ${FILE}`);
  return n;
}

// After a flush: rewrite the file with only what is still pending.
// Fully synchronous, so no append can slip in between write and rename.
function compact(Q) {
  try {
    const lines = [];
    for (const [id, v] of Q.status) lines.push(JSON.stringify({ t: 'status', id, status: v.status, sentAt: v.sentAt }));
    for (const row of Q.clicks) lines.push(JSON.stringify({ t: 'click', row }));
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, lines.length ? lines.join('\n') + '\n' : '');
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('[wal] compact failed:', e.message); }
}

function info() {
  let bytes = 0;
  try { bytes = fs.statSync(FILE).size; } catch (e) {}
  return { file: FILE, durable, bytes };
}

module.exports = { load, append, compact, info };
