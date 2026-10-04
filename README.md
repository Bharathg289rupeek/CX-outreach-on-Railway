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

The sheet stays the ops interface: paste leads in `Leads` (columns A–E as before), edit the message in `MsgTemplate!A2`. Railway fills `status`/`sent_at`, `Clicks`, `Dashboard`, `AgentLinks`.

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
3. Email script: no code change. It reads `Emaillink!F`; make sure that column pulls from `AgentLinks!E` (now Railway links).
4. Later: get a new Gupshup template whose button points straight at `APP_URL/?agent={{1}}`, update `TEMPLATE_ID`, and the bridge is no longer needed. Set `LINK_SECRET` (and later `REQUIRE_SIGNED_LINKS=true`) so nobody can open another agent's list by editing the number in the URL.

## Schedule (IST, in-process)
| When | Job |
|---|---|
| every 2 min | flush statuses + clicks to the sheet |
| every 5 min | reload `Leads` + `MsgTemplate` from the sheet |
| every 10 min | rewrite `Dashboard` + `AgentLinks` |
| 03:00 | move SENT / DUPLICATE rows from before today to `Archive` |
| 09:30 | Gupshup blast to agents with leads (once per day, remembered on the volume) |

## Admin (header `x-admin-token: $ADMIN_TOKEN`)
| Endpoint | Does |
|---|---|
| `GET /admin/stats` | queue sizes, last flush / error, volume file |
| `POST /admin/flush` | write pending clicks/statuses to the sheet now |
| `POST /admin/reload` | re-read Leads + template now (e.g. right after pasting leads) |
| `POST /admin/reports` | rewrite Dashboard + AgentLinks now |
| `POST /admin/archive` | archive now |
| `POST /admin/blast` | run today's blast (`?force=1` to resend) |
| `POST /admin/test-send?phone=98XXXXXXXX` | send the template to one number |

## Ops notes
* New leads appear in the app within `RELOAD_MIN` (5 min), or immediately after `POST /admin/reload`.
* To close a lead by hand, type anything (e.g. `CLOSED`) in its `status` cell; it's picked up on the next reload.
* Don't edit `status`/`sent_at` of leads sent in the last 2 minutes; the next flush will overwrite them.
* Google Sheets has a 10M-cell limit per spreadsheet. `Clicks` grows by a few thousand rows a day — move old months to another file periodically.

## Tests
```bash
npm test
```
Runs the store against an in-memory fake sheet: 20 simultaneous taps, cross-agent dedupe, cap, sorting rows before a flush, a tap during reload, sheet outage + restart, archive.
