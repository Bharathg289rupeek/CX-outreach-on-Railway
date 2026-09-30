# Rupeek CX Outreach v2 — Railway + Postgres + Google Sheet

## Why messages were going twice

The old flow recorded a send with a background `google.script.run.markSent(row)` call **after** WhatsApp had already opened. That call was lost in several ways:

1. **Global lock timeout.** `markSent` takes one script-wide lock for all agents (`waitLock(10000)`). With hundreds of agents tapping around 10 AM, calls queue behind each other, the 10-second wait expires, the call throws, and the lead is never stamped `SENT`.
2. **The page dies.** In WhatsApp's in-app browser, opening `wa.me` often suspends or kills the page before the background call finishes.
3. **Row numbers as IDs.** The Snapshot and cache store sheet row numbers. If anyone sorts, filters, deletes or inserts rows in `Leads` during the day, the button stamps the wrong row, and the real lead stays pending.
4. **Stale snapshot.** When `markSent` fails, the Snapshot and cache still show the lead, so it reappears on the next open.
5. **No customer-level dedupe.** The same customer on two dates, or mapped to two agents, appears twice.

## What changes

```
Ops paste leads ──► Google Sheet (Leads, MsgTemplate)
                         │  sync every 2 min, batched (≈3–5 API calls per cycle)
                         ▼
Agent taps ──► Railway app ──► Postgres (source of truth)
                  │                  │  back to sheet: Leads!F:G status, Clicks, Dashboard, AgentLinks
                  └─ /go/:id records the send atomically, THEN 302 → wa.me
```

* The **send is recorded server-side on the same request that opens WhatsApp** (`/go/:leadId`). If the record fails, WhatsApp doesn't open. A second tap, a refresh, or another agent gets an "Already sent" page instead of WhatsApp.
* **Postgres guarantees** (tested with 20 simultaneous taps: 1 succeeds, 19 blocked):
  * a lead is `SENT` once (row lock);
  * a customer is messaged once per `CX_COOLDOWN_DAYS` across **all** agents (advisory lock + check), and their other pending leads become `DUP_SKIPPED`;
  * an agent can never exceed `DAILY_CAP` (a single conditional `UPDATE`).
* **Leads are identified by `sha1(cx_phone|agent_phone|date)`**, not row numbers, so sorting or deleting rows in the sheet is safe and re-importing never duplicates.
* The **sheet stays the ops interface**: paste leads in `Leads` and edit the message in `MsgTemplate!A2` as before. `status`/`sent_at` columns, `Clicks`, `Dashboard` and `AgentLinks` are still filled in, just by Railway.
* **Agent links are signed** (`?agent=<phone>.<sig>`), so nobody can open another agent's customer list by changing the number.

## Deploy (about 30–40 minutes)

### 1. Google service account (lets Railway read and write the sheet)
1. Go to Google Cloud Console and pick a project (the one used for the Google Ads MCP works fine).
2. Open **APIs & Services → Library → Google Sheets API → Enable**.
3. Open **IAM & Admin → Service Accounts → Create**. Name it `cx-outreach` and skip the roles.
4. Open the service account, then **Keys → Add key → JSON**. The key file downloads.
5. Open the Google Sheet, click **Share**, paste the service account email (`cx-outreach@<project>.iam.gserviceaccount.com`) and give it **Editor** access.
   > If Rupeek Workspace blocks sharing outside the domain, ask IT to allowlist that one service account address.

### 2. Put the code on GitHub
Push this folder to a **private** repo. `.gitignore` already excludes `node_modules` and `.env`. Never commit the JSON key.

### 3. Railway
1. Click **New Project → Deploy from GitHub repo** and pick the repo.
2. In the project, click **+ New → Database → PostgreSQL**.
3. Open the app service, then **Variables**. Copy everything from `.env.example`:
   * `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (Railway's variable reference).
   * `GOOGLE_SERVICE_ACCOUNT_JSON`: paste the entire JSON key file content.
   * `ADMIN_TOKEN` and `LINK_SECRET`: long random strings. You can generate them with `openssl rand -hex 24`.
   * Gupshup values. **Rotate the Gupshup API key first**: the current one is hard-coded in the Apps Script and has been shared around, so treat it as exposed.
4. Under **Settings → Networking**, click **Generate Domain** and put that URL in `PUBLIC_URL`.
5. Under **Settings → Deploy**, set **Healthcheck path** to `/health` and keep **Replicas = 1**. The crons run in-process, so a second replica would double-blast; if you ever scale out, set `RUN_CRONS=false` on the extra replicas.
6. Deploy. The logs should show `DB ready`, `[tabs] all tabs present`, and `Crons on…`.

### 4. First-time data load
```bash
APP=https://your-app.up.railway.app; TOKEN=<ADMIN_TOKEN>

# Load history so the cooldown knows who was already messaged (one-time)
curl -X POST "$APP/admin/import?tab=Archive" -H "x-admin-token: $TOKEN"

# Pull today's Leads + write Dashboard / AgentLinks now
curl -X POST "$APP/admin/sync" -H "x-admin-token: $TOKEN"
```
Open the `AgentLinks` tab, then open one link on your phone and tap a lead.

### 5. Cutover from Apps Script
1. In the old Apps Script project, paste `apps-script/bridge.gs`, set `RAILWAY_URL`, then use **Deploy → Manage deployments → edit the existing deployment → New version**. This keeps the `/exec` URL that the approved template points to.
2. Run `removeOldTriggers()` once. **Important:** otherwise both systems blast agents and write to the sheet.
3. The **email script needs no code change**. It reads `Emaillink!F`. Make sure that column pulls from the `AgentLinks` tab, which Railway now writes with the new signed links.

### 6. New Gupshup template (removes the bridge hop)
Create a new UTILITY template with the same body and set the button URL to `https://your-app.up.railway.app/?agent={{1}}` (sample: `919876543210.abc123def456`). Once it's approved:
* update `GUPSHUP_TEMPLATE_ID`;
* a few days later, set `REQUIRE_SIGNED_LINKS=true`. From then on, old unsigned links and bridge links stop working, which is intended.

> A custom domain (e.g. `outreach.rupeek.com`, via Railway → Networking → Custom Domain) makes the template URL independent of Railway. It's worth doing before you submit the template.

## Daily schedule (IST, in-process)
| Time | Job |
|---|---|
| every 2 min | sync sheet ⇄ Postgres (Dashboard/AgentLinks every ~10 min) |
| 03:00 | move old SENT / DUP_SKIPPED rows from `Leads` to `Archive` (safe to run anytime now) |
| 09:30 | Gupshup blast, at most once per agent per day even across restarts |

## Admin endpoints (all `POST`, header `x-admin-token`)
| Endpoint | Does |
|---|---|
| `/admin/sync` | sync now + refresh reports |
| `/admin/blast` | run today's blast (skips agents already sent) |
| `/admin/blast?retryFailed=1` | re-send only to agents whose blast failed today |
| `/admin/blast?test=98XXXXXXXX` | send the template to one number |
| `/admin/archive` | archive now |
| `/admin/import?tab=Archive` | import a tab's history into Postgres |

## Queries
`sql/queries.sql` covers today's summary, per-agent status, a **duplicate check** (should come back empty), blocked attempts, the funnel, agents who never opened, overdue leads, blast failures, sync health, and ops fixes (undo a send, extra cap, close an agent's leads). Run them in Railway → Postgres → **Data → Query**, or with any Postgres client using the `DATABASE_PUBLIC_URL`.

## Config reference
| Var | Default | Meaning |
|---|---|---|
| `DAILY_CAP` | 10 | sends per agent per day (fresh + overdue) |
| `CX_COOLDOWN_DAYS` | 7 | block re-messaging a customer from any agent; `0` disables |
| `SYNC_EVERY_MIN` | 2 | sheet sync interval |
| `REPORT_EVERY_N_SYNCS` | 5 | Dashboard/AgentLinks refresh frequency |
| `REQUIRE_SIGNED_LINKS` | false | reject `?agent=<phone>` without signature |
| `RUN_CRONS` | true | set `false` on extra replicas |
