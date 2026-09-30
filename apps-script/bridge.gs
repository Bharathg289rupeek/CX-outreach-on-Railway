/******************************************************************
 * APPS SCRIPT BRIDGE — paste into the EXISTING Apps Script project.
 *
 * Why: the approved Gupshup template's button points at the Apps Script URL.
 * Until a new template (pointing at Railway) is approved, old links still land
 * here. This replaces doGet so agents are sent on to the Railway app instead of
 * the old sheet-backed page. Nothing else in the old project should run.
 *
 * Steps:
 *  1. Replace the old doGet() with the one below, set RAILWAY_URL.
 *  2. Deploy → Manage deployments → edit the EXISTING deployment → New version
 *     (keeps the same /exec URL that's baked into the template).
 *  3. Run removeOldTriggers() once, so the old 3 AM / 4 AM / 9:30 / hourly jobs stop
 *     (otherwise agents get TWO blasts and two systems write to the sheet).
 ******************************************************************/

const RAILWAY_URL = 'https://YOUR-APP.up.railway.app';

function doGet(e) {
  const agent = (e && e.parameter && e.parameter.agent) || '';
  const url = RAILWAY_URL + '/?agent=' + encodeURIComponent(agent);
  const html =
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<div style="font-family:system-ui;padding:28px;text-align:center">' +
    '<p style="font-size:16px">Your outreach list has moved.</p>' +
    '<a href="' + url + '" target="_top" style="display:block;background:#25d366;color:#fff;padding:14px;' +
    'border-radius:10px;font-weight:600;text-decoration:none;font-size:16px">📲 Open my customer list</a>' +
    '</div>' +
    // try an automatic hop; if the browser blocks it, the button above still works
    '<script>try{window.top.location.replace(' + JSON.stringify(url) + ');}catch(e){}</script>';
  return HtmlService.createHtmlOutput(html)
    .setTitle('Rupeek CX Outreach')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function removeOldTriggers() {
  const old = ['sendDailyAgentLinks', 'refreshDashboard', 'archiveOldSent', 'bakeDailyQueues'];
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(t => {
    if (old.indexOf(t.getHandlerFunction()) > -1) { ScriptApp.deleteTrigger(t); n++; }
  });
  Logger.log(n + ' old triggers removed');
}
