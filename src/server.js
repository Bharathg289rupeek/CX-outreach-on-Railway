/******************************************************************
 * RUPEEK CX OUTREACH — Railway app, Google Sheet as the database.
 *
 *   Ops paste leads ──► Google Sheet (Leads, MsgTemplate)
 *                              │  reload every RELOAD_MIN (new leads, template edits)
 *                              ▼
 *   Agent taps ──► /s/:id ──► in-memory claim + Railway volume log ──► WhatsApp
 *                              │  flush every FLUSH_MS (2 min), batched
 *                              ▼
 *                 Leads!F:G status/sent_at, Clicks, Dashboard, AgentLinks
 ******************************************************************/
const path = require('path');
const express = require('express');
const cron = require('node-cron');
const cfg = require('./config');
const store = require('./store');
const jobs = require('./jobs');
const views = require('./views');
const { verifyAgent, normPhone } = require('./util');

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '7d' }));
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const notReady = (res) => res.status(503).send(views.renderInfo('⏳', 'Starting up', 'Please try again in a few seconds.'));

// ------------------------------ agent app ------------------------------
app.get('/', (req, res) => {
  const param = String(req.query.agent || '').trim();
  if (!param) return res.send(views.renderApp('', null));
  const phone = verifyAgent(param);
  if (!phone) return res.status(403).send(views.renderInfo('🔒', 'Invalid link', 'Please open the latest link sent to you on WhatsApp.'));
  if (!store.ready()) return notReady(res);
  const data = store.buildQueue(phone);
  store.logClick('APP_OPEN', phone, data.agentName);
  res.send(views.renderApp(param, data));
});

app.get('/api/queue', (req, res) => {
  const phone = verifyAgent(req.query.agent);
  if (!phone) return res.status(403).json({ error: 'bad_link' });
  if (!store.ready()) return res.status(503).json({ error: 'starting' });
  res.json(store.buildQueue(phone));
});

// The ONLY way to open WhatsApp: claim the lead first (synchronously), then hand off.
// A second tap / refresh / another agent gets an info page instead of WhatsApp.
app.get('/s/:id', (req, res) => {
  const param = String(req.query.agent || '').trim();
  const phone = verifyAgent(param);
  if (!phone) return res.status(403).send(views.renderInfo('🔒', 'Invalid link', 'Please open the latest link sent to you on WhatsApp.'));
  if (!store.ready()) return notReady(res);

  const r = store.markSend(phone, String(req.params.id));
  const L = r.lead || {};
  switch (r.code) {
    case 'ok':
      return res.send(views.renderHandoff(r.waLink, L));
    case 'reopen':
      return res.send(views.renderReopen(r.waLink, L, param));
    case 'already':
      return res.status(409).send(views.renderInfo('✅', 'Already sent',
        `${views.esc(L.cxName || 'This customer')} was already messaged. Go back to your list.`, param));
    case 'dup':
      return res.status(409).send(views.renderInfo('🚫', 'Already contacted',
        `${views.esc(L.cxName || 'This customer')} was messaged on ${views.esc(r.lastSent)}, so it has been removed from your list.`, param));
    case 'capped':
      return res.status(409).send(views.renderInfo('🧢', 'Daily limit reached',
        `You have sent ${cfg.DAILY_CAP} messages today. Come back tomorrow.`, param));
    case 'closed':
      return res.status(409).send(views.renderInfo('ℹ️', 'Lead closed', 'This lead is no longer active.', param));
    default:
      return res.status(404).send(views.renderInfo('❓', 'Not found', 'This customer is not in your list.', param));
  }
});

app.get('/health', (req, res) => {
  const s = store.stats();
  res.status(s.ready ? 200 : 503).json(s);
});

// ------------------------------ admin ------------------------------
// curl -X POST "https://<app>/admin/flush" -H "x-admin-token: $ADMIN_TOKEN"
function admin(req, res, next) {
  const t = req.get('x-admin-token') || req.query.token;
  if (!cfg.ADMIN_TOKEN || t !== cfg.ADMIN_TOKEN) return res.status(401).send('unauthorized');
  next();
}
const run = (fn) => async (req, res) => {
  try {
    const out = await fn(req);
    typeof out === 'string' ? res.type('text').send(out) : res.json(out);
  } catch (e) { res.status(500).type('text').send('ERROR: ' + e.message); }
};
app.get('/admin/stats',     admin, run(() => store.stats()));
app.post('/admin/flush',    admin, run(() => store.flush()));
app.post('/admin/reload',   admin, run(() => store.reload()));
app.post('/admin/reports',  admin, run(async () => `${await jobs.refreshDashboard()} · ${await jobs.writeAgentLinks()}`));
app.post('/admin/archive',  admin, run(() => store.archive()));
app.post('/admin/blast',    admin, run((req) => jobs.sendAgentLinks(req.query.force === '1')));
app.post('/admin/test-send', admin, run((req) => jobs.testSend(normPhone(req.query.phone))));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send(views.renderInfo('⚠️', 'Something went wrong', 'Please go back and try again.'));
});

// ------------------------------ boot + schedules ------------------------------
const safe = (name, fn) => () => Promise.resolve().then(fn)
  .then((r) => r && r !== 'nothing to flush' && console.log(`[${name}]`, r))
  .catch((e) => console.error(`[${name}] FAILED`, e.message));

async function boot() {
  app.listen(cfg.PORT, () => console.log('Listening on', cfg.PORT));   // listen first so /health answers during load
  for (let i = 1; ; i++) {
    try { await store.init(); break; }
    catch (e) { console.error(`[boot] sheet load failed (attempt ${i}):`, e.message); await new Promise((r) => setTimeout(r, Math.min(60000, 5000 * i))); }
  }

  setInterval(safe('flush', () => store.flush()), cfg.FLUSH_MS);
  setInterval(safe('reload', () => store.reload()), cfg.RELOAD_MIN * 60000);

  // Run crons on exactly ONE instance (Railway replicas = 1)
  if (cfg.RUN_CRONS) {
    const opt = { timezone: cfg.TZ };
    const reports = safe('reports', async () => `${await jobs.refreshDashboard()} · ${await jobs.writeAgentLinks()}`);
    setInterval(reports, cfg.REPORT_MIN * 60000);
    cron.schedule('0 3 * * *', safe('archive', () => store.archive()), opt);
    cron.schedule('30 9 * * *', safe('blast', () => jobs.sendAgentLinks()), opt);
    reports();
    console.log(`Schedules on: flush ${cfg.FLUSH_MS / 1000}s, reload ${cfg.RELOAD_MIN}m, reports ${cfg.REPORT_MIN}m, archive 03:00, blast 09:30 IST`);
  }
}

// Railway sends SIGTERM on redeploy: push what we have to the sheet first (the WAL covers us if this fails)
let stopping = false;
async function shutdown(sig) {
  if (stopping) return; stopping = true;
  console.log(`[${sig}] flushing before exit…`);
  try { console.log('[flush]', await Promise.race([store.flush(), new Promise((r) => setTimeout(() => r('timeout'), 8000))])); }
  catch (e) { console.error('[flush] on exit failed:', e.message); }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) boot();
module.exports = { app, boot };
