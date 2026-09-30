-- ============================================================
-- Rupeek CX Outreach — Postgres schema (runs automatically on boot, idempotent)
-- Google Sheet = where ops paste leads + view reports
-- Postgres     = live source of truth for who was messaged (atomic, no quota)
-- ============================================================

-- One row per lead. lead_key = sha1(cx_phone|agent_phone|lead_date) so re-importing
-- the sheet never creates duplicates and sorting/deleting sheet rows can't break anything.
CREATE TABLE IF NOT EXISTS leads (
  id            BIGSERIAL PRIMARY KEY,
  lead_key      TEXT        NOT NULL UNIQUE,
  cx_phone      TEXT        NOT NULL,
  cx_name       TEXT        NOT NULL DEFAULT '',
  agent_phone   TEXT        NOT NULL,
  agent_name    TEXT        NOT NULL DEFAULT '',
  lead_date     DATE        NOT NULL,
  status        TEXT,                        -- NULL = pending | SENT | DUP_SKIPPED | any manual status from sheet
  sent_at       TIMESTAMPTZ,
  source_tab    TEXT        NOT NULL DEFAULT 'Leads',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leads_agent_pending_idx ON leads (agent_phone, lead_date) WHERE status IS NULL;
CREATE INDEX IF NOT EXISTS leads_cx_idx            ON leads (cx_phone, sent_at);
CREATE INDEX IF NOT EXISTS leads_sent_at_idx       ON leads (sent_at) WHERE status = 'SENT';

-- Per-agent per-day counter. The cap is enforced with a single conditional UPDATE,
-- so two taps at the same moment can never both pass.
CREATE TABLE IF NOT EXISTS agent_daily (
  agent_phone TEXT NOT NULL,
  day         DATE NOT NULL,
  sent_count  INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_phone, day)
);

-- Every event (APP_OPEN, SEND_CLICK, SEND_BLOCKED, LINK_SENT, LINK_FAIL).
-- synced=false rows are appended to the sheet's Clicks tab in one batch per sync cycle.
CREATE TABLE IF NOT EXISTS events (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  event       TEXT        NOT NULL,
  agent_phone TEXT,
  agent_name  TEXT,
  cx_phone    TEXT,
  cx_name     TEXT,
  lead_id     BIGINT,
  detail      TEXT,
  synced      BOOLEAN     NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS events_unsynced_idx ON events (id) WHERE synced = false;
CREATE INDEX IF NOT EXISTS events_agent_ts_idx ON events (agent_phone, ts);

-- Guarantees the 9:30 blast goes to each agent at most once per day,
-- even if Railway restarts the container mid-blast.
CREATE TABLE IF NOT EXISTS blast_log (
  agent_phone TEXT NOT NULL,
  day         DATE NOT NULL,
  ok          BOOLEAN,
  detail      TEXT,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_phone, day)
);

-- Key/value settings synced from the sheet (e.g. MsgTemplate!A2).
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
