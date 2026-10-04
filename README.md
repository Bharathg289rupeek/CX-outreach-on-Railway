# Rupeek CX Outreach v2 — Railway app, Google Sheet as the database

## Why the same customer got the message twice (Apps Script version)

Each tap opened WhatsApp and *then* fired `google.script.run.markSent(row)` in the background. That call was regularly lost:

1. **Global lock timeout.** `markSent` takes one script-wide lock (`waitLock(10000)`). With hundreds of agents tapping around 10 AM, calls queue, the wait expires, and the lead is never stamped `SENT`.
2. **The page dies.** WhatsApp's in-app browser often suspends the page the moment `wa.me` opens, before the background call finishes.
3. **Row numbers as IDs.** Snapshot/cache store row numbers. Any sort / insert / delete in `Leads` (or the 3 AM archive) makes the next write hit the wrong row.
4. **Stale snapshot.** When `markSent` fails, the Snapshot and cache still show the lead, so it reappears on the next open.
5. **No customer-level dedupe.** The same customer on two dates, or mapped to two agents, appears twice.

## How v2 fixes it

```
Ops paste leads ──► Google Sheet (Leads, MsgTemplate)          ◄── still the database + ops UI
                         │  reload every 5 min (new leads, template edits)
                         ▼
Agent taps ──► Railway /s/:id ──► claim in memory + write to Railway volume ──► WhatsApp
                         │  flush every 2 min, one batch
                         ▼
               Leads!F:G status/sent_at · Clicks · Dashboard · AgentLinks
```

* **The send is recorded on the server before WhatsApp opens.** The tap goes to `/s/:id`. The server claims the lead synchronously (Node runs one request's check-and-set to completion before the next), so 20 simultaneous taps → 1 send, 19 blocked.
* **Nothing is lost if the sheet is slow or Railway restarts.** Each click/status is appended to `/data/pending.jsonl` on a Railway volume *before* the response. Every 2 minutes the queue is written to the sheet in one batch; failures stay in the file and retry. A restart replays the file.
* **Leads are identified by `cx_phone + agent_phone + Date`, not row numbers**, so sorting, inserting, deleting or archiving rows never misdirects a write. The same row pasted twice is one lead.
* **Customer dedupe across agents:** a customer messaged by anyone in the last `DEDUPE_DAYS` (default 7) is hidden from every agent; a tap on it marks the lead `DUPLICATE`.
* **Daily cap** (`DAILY_CAP`, default 10) is enforced on the server.
* **WhatsApp didn't open?** The same agent can tap the lead again within `REOPEN_MIN` (15 min) and gets an "Already recorded — open WhatsApp again" page. It still counts once.

The sheet stays the ops interface: paste leads in `Leads` (columns A–E as before), edit the message in `MsgTemplate!A2`, and choose how each agent gets their link in `Agents`. Railway fills `status`/`sent_at`, `Clicks`, `Dashboard`, `AgentLinks`.

## Agent links: WhatsApp or email

The `Agents` tab decides how each agent gets their daily link. Railway adds every agent it sees in `Leads` there automatically, so ops only fill columns C and D:

| A agent_phone | B agent_name | C email | D link_channel |
|---|---|---|---|
| 9000000001 | Ravi | | WHATSAPP |
| 9000000002 | Sita | sita@rupeek.com | EMAIL |
| 9000000003 | Gopal | gopal@rupeek.com | BOTH |
| 9000000004 | Meena | | NONE |

* A blank channel uses `DEFAULT_CHANNEL` (WhatsApp unless changed).
* `EMAIL` with no address falls back to WhatsApp, so the agent still gets the link.
* Edits are picked up within 5 minutes, and always right before the 9:30 send.
* The email has the same content as the old Apps Script email (target, today's leads, overdue, button), so `Emaillink` and that script can be retired.
* `Dashboard` → `link_sent_today` shows `WhatsApp`, `Email`, `WhatsApp + Email`, `FAILED` or `No`. Failures carry the reason in `Clicks` (`LINK_FAIL`, column G).

**Email setup (Railway):** Railway blocks outgoing SMTP on non-Pro plans (you get `Connection timeout`), so send through the HTTPS relay:
1. script.google.com → New project → paste `apps-script/mail-relay.gs`.
2. Project Settings → Script Properties → `RELAY_SECRET` = a long random string.
3. Deploy → New deployment → Web app → Execute as **Me**, Who has access **Anyone** → copy the `/exec` URL.
4. Railway: `MAIL_RELAY_URL` = that URL, `MAIL_RELAY_SECRET` = the same secret. Optional `MAIL_FROM=Rupeek CX Team <…>` sets the sender name.

Mail goes out from the Google account that deployed the relay (Workspace quota: 1,500 recipients/day).

**Or SMTP** (Railway Pro or another host): set `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` in Railway. For Google Workspace: turn on 2-step verification for the sending mailbox, create an **App Password** (Google Account → Security → App passwords), and use `smtp.gmail.com` / `587`. If Rupeek IT blocks App Passwords, any SMTP provider (SendGrid, AWS SES) works with the same variables.

> Run **exactly one** Railway replica. State lives in that one process.

## Deploy

### 1. Google service account (lets Railway read and write the sheet)
1. Google Cloud Console → pick a project → **APIs & Services → Library → Google Sheets API → Enable**.
2. **IAM & Admin → Service Accounts → Create** (`cx-outreach`, no roles) → **Keys → Add key → JSON**.
3. Open the sheet → **Share** → paste the service account email → **Editor**.
   > If Rupeek Workspace blocks external sharing, ask IT to allowlist that one address.

### 2. Railway
1. **New Project → Deploy from GitHub repo** (private repo; `.env` and keys are git-ignored).
2. App service → **Settings → Volumes → Add volume**, mount path **`/data`**. *Required* — this is where clicks are stored before they reach the sheet.
3. **Variables** — copy from `.env.example`:
   * `GOOGLE_SERVICE_ACCOUNT_JSON`: the whole key file (raw JSON or base64).
   * `ADMIN_TOKEN`: long random string (`openssl rand -hex 24`).
   * `GUPSHUP_API_KEY`: **rotate it first** — the old key is hard-coded in the Apps Script and should be treated as exposed.
4. **Settings → Networking → Generate Domain**, put it in `APP_URL`.
5. **Settings → Deploy**: healthcheck path `/health`, replicas = **1**.
6. Deploy. Logs should show `[store] ready — N leads, M agents` and `Schedules on: …`.

### 3. Check it
```bash
curl https://your-app.up.railway.app/health
```
Open the `AgentLinks` tab (filled within a minute), open one link on your phone, tap a lead, and confirm the row gets `SENT` within ~2 minutes.

### 4. Cutover from Apps Script
1. In the old Apps Script project, paste `apps-script/bridge.gs` over the old code, set `RAILWAY_URL`, then **Deploy → Manage deployments → edit the existing deployment → New version**. This keeps the `/exec` URL the approved Gupshup template points to, so agents' buttons keep working.
2. Run `removeOldTriggers()` once. **Important** — otherwise both systems blast agents and write to the sheet.
3. Email: Railway now sends link emails itself. Copy agent emails from `Emaillink` into the `Agents` tab (column C, channel `EMAIL` or `BOTH`), set the SMTP variables, then delete the old email script's 9 AM / 1 PM triggers so agents don't get two emails.
4. Later: get a new Gupshup template whose button points straight at `APP_URL/?agent={{1}}`, update `TEMPLATE_ID`, and the bridge is no longer needed. Set `LINK_SECRET` (and later `REQUIRE_SIGNED_LINKS=true`) so nobody can open another agent's list by editing the number in the URL.

## Schedule (IST, in-process)
| When | Job |
|---|---|
| every 2 min | flush statuses + clicks to the sheet |
| every 5 min | reload `Leads` + `MsgTemplate` from the sheet |
| every 10 min | rewrite `Dashboard` + `AgentLinks` |
| 03:00 | move SENT / DUPLICATE rows from before today to `Archive` |
| 09:30 | agent-link blast by WhatsApp and/or email per the `Agents` tab (once per day, remembered on the volume) |

## Admin dashboard — `https://<your-app>/admin`

Sign in with `ADMIN_TOKEN` (stays signed in for 7 days on that browser). It shows:
* **Status:** WhatsApp / email configured, whether today's 9:30 blast ran, last sheet sync (and any error), changes waiting for the sheet, volume OK.
* **Today's numbers:** agents with leads, leads today / overdue, messages sent vs capacity, sent this month, links delivered (and failures), agents who opened the app.
* **Every agent:** link channel + email, today / overdue / sent / month, whether today's link went out (WhatsApp, Email, FAILED with the reason on hover), opens, last activity.
* **Send links:** per agent (**WhatsApp**, **Email**, or **Copy link**), or tick several agents and send by their Agents-tab channel / WhatsApp / Email / both. Email for an agent with no address asks for one. Results show per agent.
* **Buttons:** send today's links to everyone (or resend), sync to sheet, reload sheet, refresh the Dashboard/AgentLinks tabs, archive.
* **Filters:** link not sent, link failed, link sent but not opened, daily limit reached, has email.

Everything shown comes from memory, so the page loads instantly and doesn't use Sheets quota. Email and channel are still edited in the `Agents` tab.

## Admin API (header `x-admin-token: $ADMIN_TOKEN`)
| Endpoint | Does |
|---|---|
| `GET /admin/stats` | queue sizes, last flush / error, volume file |
| `POST /admin/flush` | write pending clicks/statuses to the sheet now |
| `POST /admin/reload` | re-read Leads + template now (e.g. right after pasting leads) |
| `POST /admin/reports` | rewrite Dashboard + AgentLinks now |
| `POST /admin/archive` | archive now |
| `POST /admin/blast` | run today's blast (`?force=1` to resend) |
| `POST /admin/send-link?phone=98XXXXXXXX` | send one agent their link now, per their `Agents` channel |
| `…&channel=whatsapp\|email\|both` | override the channel |
| `…&channel=email&email=me@rupeek.com` | send that agent's link to a test address |

## Ops notes
* New leads appear in the app within `RELOAD_MIN` (5 min), or immediately after `POST /admin/reload`.
* To close a lead by hand, type anything (e.g. `CLOSED`) in its `status` cell; it's picked up on the next reload.
* Don't edit `status`/`sent_at` of leads sent in the last 2 minutes; the next flush will overwrite them.
* Google Sheets has a 10M-cell limit per spreadsheet. `Clicks` grows by a few thousand rows a day — move old months to another file periodically.

## Tests
```bash
npm test
```
Runs the store against an in-memory fake sheet (20 simultaneous taps, cross-agent dedupe, cap, sorting rows before a flush, a tap during reload, sheet outage + restart, archive) and the link blast per channel with Gupshup and SMTP stubbed.
