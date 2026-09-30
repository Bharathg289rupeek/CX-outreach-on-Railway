const path = require('path');
const express = require('express');
const cron = require('node-cron');
const db = require('./db');
const sheets = require('./sheets');
const { sendDailyAgentLinks } = require('./blast');
const { verifyAgentParam, normPhone, today, TZ } = require('./util');
const ui = require('./ui');

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '7d' }));

// ------------------------------ agent app ------------------------------
app.get('/', async (req, res, next) => {
  try {
    const param = String(req.query.agent || '');
    if (!param) return res.send(ui.loginPage());
    const phone = verifyAgentParam(param);
    if (!phone) return res.status(403).send(ui.infoPage('bad_link'));
    const data = await db.getQueue(phone);
    db.logEvent({ event: 'APP_OPEN', agentPhone: phone, agentName: data.agentName }).catch(() => {});
    res.send(ui.agentPage(param, data));
  } catch (e) { next(e); }
});

app.get('/api/queue', async (req, res, next) => {
  try {
    const phone = verifyAgentParam(req.query.agent);
    if (!phone) return res.status(403).json({ error: 'bad_link' });
    res.json(await db.getQueue(phone));
  } catch (e) { next(e); }
});

// The only way to open WhatsApp: record atomically, THEN redirect.
// A second tap / refresh / other agent gets an info page instead of WhatsApp.
app.get('/go/:leadId', async (req, res, next) => {
  try {
    const param = String(req.query.agent || '');
    const phone = verifyAgentParam(param);
    const leadId = Number(req.params.leadId);
    if (!phone || !Number.isInteger(leadId)) return res.status(403).send(ui.infoPage('bad_link'));

    const r = await db.recordSend(leadId, phone);
    if (!r.ok) {
      db.logEvent({ event: 'SEND_BLOCKED', agentPhone: phone, cxPhone: r.lead && r.lead.cx_phone,
        cxName: r.lead && r.lead.cx_name, leadId, detail: r.reason }).catch(() => {});
      return res.status(409).send(ui.infoPage(r.reason, param));
    }
    const tpl = await db.getTemplate();
    const msg = tpl
      .replace(/\{\{\s*cx_name\s*\}\}/g, r.lead.cx_name || 'Customer')
      .replace(/\{\{\s*agent_name\s*\}\}/g, r.lead.agent_name || 'Rupeek');
    res.redirect(302, 'https://wa.me/' + r.lead.cx_phone + '?text=' + encodeURIComponent(msg));
  } catch (e) { next(e); }
});

app.get('/health', async (req, res) => {
  try { await db.pool.query('SELECT 1'); res.json({ ok: true, date: today() }); }
  catch (e) { res.status(500).json({ ok: false }); }
});

// ------------------------------ admin ------------------------------
// curl -X POST "https://<app>/admin/sync" -H "x-admin-token: $ADMIN_TOKEN"
function admin(req, res, next) {
  if (!process.env.ADMIN_TOKEN || req.get('x-admin-token') !== process.env.ADMIN_TOKEN) return res.status(401).send('unauthorized');
  next();
}
const run = fn => async (req, res) => {
  try { res.type('text').send(String(await fn(req))); }
  catch (e) { res.status(500).type('text').send('ERROR: ' + e.message); }
};
app.post('/admin/sync',    admin, run(() => sheets.syncOnce({ forceReports: true })));
app.post('/admin/archive', admin, run(() => sheets.archiveOld()));
app.post('/admin/import',  admin, run(req => sheets.importTab(String(req.query.tab || 'Archive'))));
app.post('/admin/blast',   admin, run(async req => {
  if (req.query.test) return sendDailyAgentLinks({ onlyPhone: normPhone(req.query.test) });
  if (req.query.retryFailed) {
    await db.pool.query(`DELETE FROM blast_log WHERE day=$1 AND ok IS NOT TRUE`, [today()]);
  }
  await sheets.syncOnce({ forceReports: true }).catch(() => {});
  return sendDailyAgentLinks();
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send(ui.infoPage('error'));
});

// ------------------------------ boot + crons ------------------------------
(async () => {
  await db.migrate();
  console.log('DB ready');
  try { console.log('[tabs]', await sheets.ensureTabs()); } catch (e) { console.error('[tabs] FAILED', e.message); }

  // Run crons on exactly ONE instance (keep Railway replicas = 1, or set RUN_CRONS=false on extras)
  if (process.env.RUN_CRONS !== 'false') {
    const opt = { timezone: TZ };
    const every = Number(process.env.SYNC_EVERY_MIN || 2);
    cron.schedule(`*/${every} * * * *`, () => sheets.syncOnce().catch(() => {}), opt);
    cron.schedule('0 3 * * *',  () => sheets.archiveOld().catch(() => {}), opt);
    cron.schedule('30 9 * * *', async () => {
      await sheets.syncOnce({ forceReports: true }).catch(() => {});
      await sendDailyAgentLinks().catch(e => console.error('[blast] FAILED', e.message));
    }, opt);
    sheets.syncOnce({ forceReports: true }).catch(() => {});
    console.log(`Crons on: sync every ${every} min, archive 03:00, blast 09:30 (${TZ})`);
  }

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('Listening on', port));
})().catch(e => { console.error('Boot failed', e); process.exit(1); });
