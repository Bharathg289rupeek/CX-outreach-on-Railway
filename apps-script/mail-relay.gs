/******************************************************************
 * MAIL RELAY — lets the Railway app send agent-link emails from your
 * Rupeek Google account over HTTPS.
 *
 * Why: Railway blocks outgoing SMTP (Gmail port 587) on non-Pro plans, so
 * the app gets "Connection timeout". Apps Script's MailApp sends the mail
 * instead, exactly like the old "CX Outreach Daily Email" script did.
 *
 * Setup (once, ~3 min):
 *  1. script.google.com → New project → paste this file → name it "CX mail relay".
 *  2. Project Settings (gear) → Script Properties → Add:
 *        RELAY_SECRET = <long random string>   (same value as MAIL_RELAY_SECRET in Railway)
 *  3. Deploy → New deployment → type "Web app":
 *        Execute as:      Me
 *        Who has access:  Anyone
 *     → Deploy → authorize → copy the Web app URL (ends in /exec).
 *  4. Railway Variables:  MAIL_RELAY_URL = that URL,  MAIL_RELAY_SECRET = same secret.
 *  5. Run testRelay() once here to check it sends to you.
 *
 * Only requests carrying the secret are accepted. Quota: 1,500 recipients/day
 * on Google Workspace (MailApp.getRemainingDailyQuota()).
 ******************************************************************/

function doPost(e) {
  let out;
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const secret = PropertiesService.getScriptProperties().getProperty('RELAY_SECRET');
    if (!secret || body.secret !== secret) {
      out = { ok: false, err: 'bad secret' };
    } else if (!body.to || String(body.to).indexOf('@') < 0) {
      out = { ok: false, err: 'bad recipient' };
    } else if (MailApp.getRemainingDailyQuota() < 1) {
      out = { ok: false, err: 'Google daily email quota used up' };
    } else {
      MailApp.sendEmail({
        to: String(body.to).trim(),
        subject: String(body.subject || 'CX Outreach'),
        htmlBody: String(body.html || ''),
        body: String(body.text || ''),
        name: String(body.fromName || 'Rupeek CX Team'),
      });
      out = { ok: true, quotaLeft: MailApp.getRemainingDailyQuota() };
    }
  } catch (err) {
    out = { ok: false, err: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// Health check: opening the /exec URL in a browser shows this
function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, relay: 'cx-outreach', quotaLeft: MailApp.getRemainingDailyQuota() }))
    .setMimeType(ContentService.MimeType.JSON);
}

// Run once from the editor: sends a test mail to yourself through doPost
function testRelay() {
  const secret = PropertiesService.getScriptProperties().getProperty('RELAY_SECRET');
  const me = Session.getActiveUser().getEmail();
  const r = doPost({ postData: { contents: JSON.stringify({ secret, to: me, subject: 'CX relay test', html: '<b>Relay works.</b>', text: 'Relay works.' }) } });
  Logger.log(r.getContent());
}
