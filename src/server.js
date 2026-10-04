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
const crypto = require('crypto');
const views = require('./views');
const adminView = require('./adminView');
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
// Browser: /admin → sign in with ADMIN_TOKEN → HttpOnly session cookie.
// Scripts: curl -X POST "https://<app>/admin/flush" -H "x-admin-token: $ADMIN_TOKEN"
const COOKIE = 'cxo_admin';
const sessionValue = () => crypto.createHmac('sha256', cfg.ADMIN_TOKEN).update('admin-session-v1').digest('hex');
const same = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function cookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
const isAdmin = (req) => !!cfg.ADMIN_TOKEN &&
  (same(req.get('x-admin-token') || req.query.token, cfg.ADMIN_TOKEN) || same(cookie(req, COOKIE), sessionValue()));
function admin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).send('unauthorized');
  next();
}

app.get('/admin', (req, res) => {
  if (!cfg.ADMIN_TOKEN) return res.status(503).send(adminView.loginPage('ADMIN_TOKEN is not set in Railway variables.'));
  res.send(isAdmin(req) ? adminView.dashboardPage() : adminView.loginPage());
});
let loginFails = 0, loginLockUntil = 0;   // slow down token guessing
app.post('/admin/login', express.urlencoded({ extended: false }), (req, res) => {
  if (Date.now() < loginLockUntil) return res.status(429).send(adminView.loginPage('Too many attempts. Wait a minute.'));
  if (!cfg.ADMIN_TOKEN || !same(String((req.body && req.body.token) || '').trim(), cfg.ADMIN_TOKEN)) {
    if (++loginFails >= 5) { loginFails = 0; loginLockUntil = Date.now() + 60000; }
    return res.status(401).send(adminView.loginPage('Wrong token.'));
  }
  loginFails = 0;
  const secure = req.secure || req.get('x-forwarded-proto') === 'https' ? '; Secure' : '';
  res.set('Set-Cookie', `${COOKIE}=${sessionValue()}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${7 * 86400}${secure}`);
  res.redirect(303, '/admin');
});
app.get('/admin/logout', (req, res) => {
  res.set('Set-Cookie', `${COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0`);
  res.redirect(303, '/admin');
});

const run = (fn) => async (req, res) => {
  try {
    const out = await fn(req);
    typeof out === 'string' ? res.type('text').send(out) : res.json(out);
  } catch (e) { res.status(500).type('text').send('ERROR: ' + e.message); }
};
app.get('/admin/stats',     admin, run(() => store.stats()));
app.get('/admin/api/overview', admin, (req, res) => {
  if (!store.ready()) return res.status(503).json({ error: 'starting' });
  res.json(jobs.overview());
});
app.post('/admin/api/send', admin, express.json({ limit: '200kb' }), run((req) => {
  const b = req.body || {};
  if (!Array.isArray(b.phones) || !b.phones.length) throw new Error('no agents selected');
  if (b.phones.length > 2000) throw new Error('too many agents in one request');
  const ch = String(b.channel || '').toLowerCase();
  if (ch && !['whatsapp', 'email', 'both'].includes(ch)) throw new Error('bad channel');
  return jobs.sendLinks(b.phones, { channel: ch, email: String(b.email || '').trim() });
}));
app.post('/admin/flush',    admin, run(() => store.flush()));
app.post('/admin/reload',   admin, run(() => store.reload()));
const reportsJob = async () => `${await store.syncAgentsTab()} · ${await jobs.refreshDashboard()} · ${await jobs.writeAgentLinks()}`;
app.post('/admin/reports',  admin, run(reportsJob));
app.post('/admin/archive',  admin, run(() => store.archive()));
app.post('/admin/blast',    admin, run((req) => jobs.sendAgentLinks(req.query.force === '1')));
app.post('/admin/test-send', admin, run((req) => jobs.testSend(normPhone(req.query.phone), { channel: req.query.channel, email: req.query.email })));
app.post('/admin/send-link',  admin, run((req) => jobs.testSend(normPhone(req.query.phone), { channel: req.query.channel, email: req.query.email })));

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
    const reports = safe('reports', reportsJob);
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
