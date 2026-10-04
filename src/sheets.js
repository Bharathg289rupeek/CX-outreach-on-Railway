/******************************************************************
 * Thin Google Sheets API wrapper (service account).
 * Reads return raw values: numbers stay numbers, dates come back as serial
 * numbers (util.dstr converts them). Writes use USER_ENTERED so "'9198…"
 * stays text and "2026-10-03 10:15:00" becomes a real date-time.
 * Every call retries on quota (429) and transient 5xx errors.
 ******************************************************************/
const { google } = require('googleapis');
const cfg = require('./config');
const { sleep } = require('./util');

let _api = null;
function api() {
  if (_api) return _api;
  if (!cfg.SHEET_ID) throw new Error('SHEET_ID is not set');
  if (!cfg.GOOGLE_CREDS.client_email) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set or invalid');
  const auth = new google.auth.GoogleAuth({ credentials: cfg.GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  _api = google.sheets({ version: 'v4', auth });
  return _api;
}

async function withRetry(fn, tries = 5) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      const code = Number(e.code || (e.response && e.response.status) || 0);
      const transient = code === 429 || code >= 500 || /ECONNRESET|ETIMEDOUT|socket hang up/i.test(String(e.message));
      if (!transient || i >= tries) throw e;
      await sleep(Math.min(30000, 1000 * 2 ** i));
    }
  }
}

async function read(range, opts = {}) {
  const r = await withRetry(() => api().spreadsheets.values.get({
    spreadsheetId: cfg.SHEET_ID, range,
    valueRenderOption: opts.valueRenderOption || 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER',
  }));
  return r.data.values || [];
}

async function batchWrite(data) {
  if (!data || !data.length) return;
  for (let i = 0; i < data.length; i += 500) {
    const chunk = data.slice(i, i + 500);
    await withRetry(() => api().spreadsheets.values.batchUpdate({
      spreadsheetId: cfg.SHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data: chunk },
    }));
  }
}

async function append(range, rows) {
  if (!rows || !rows.length) return;
  await withRetry(() => api().spreadsheets.values.append({
    spreadsheetId: cfg.SHEET_ID, range,
    valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  }));
}

async function clear(range) {
  await withRetry(() => api().spreadsheets.values.clear({ spreadsheetId: cfg.SHEET_ID, range }));
}

async function ensureTabs(names) {
  const meta = await withRetry(() => api().spreadsheets.get({ spreadsheetId: cfg.SHEET_ID, fields: 'sheets.properties.title' }));
  const have = new Set(meta.data.sheets.map((s) => s.properties.title));
  const missing = names.filter((t) => !have.has(t));
  if (missing.length) {
    await withRetry(() => api().spreadsheets.batchUpdate({
      spreadsheetId: cfg.SHEET_ID,
      requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) },
    }));
    console.log('[sheets] created tabs:', missing.join(', '));
  }
}

module.exports = { read, batchWrite, append, clear, ensureTabs };
