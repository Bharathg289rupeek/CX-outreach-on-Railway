-- ============================================================
-- Rupeek CX Outreach — handy queries (Railway → Postgres → Data → Query)
-- All dates are IST.
-- ============================================================

-- 1) Today at a glance
SELECT
  count(*) FILTER (WHERE status = 'SENT' AND (sent_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date) AS sent_today,
  count(*) FILTER (WHERE status IS NULL AND lead_date =  (now() AT TIME ZONE 'Asia/Kolkata')::date) AS fresh_pending,
  count(*) FILTER (WHERE status IS NULL AND lead_date <  (now() AT TIME ZONE 'Asia/Kolkata')::date) AS overdue_pending,
  count(*) FILTER (WHERE status = 'DUP_SKIPPED' AND updated_at::date = now()::date)                   AS dup_blocked_today
FROM leads;

-- 2) Per-agent today: sent vs cap, pending, opens
SELECT l.agent_phone, max(l.agent_name) AS agent_name,
       COALESCE(d.sent_count, 0) AS sent_today,
       count(*) FILTER (WHERE l.status IS NULL AND l.lead_date = (now() AT TIME ZONE 'Asia/Kolkata')::date) AS fresh_pending,
       count(*) FILTER (WHERE l.status IS NULL AND l.lead_date < (now() AT TIME ZONE 'Asia/Kolkata')::date)  AS overdue_pending,
       (SELECT count(*) FROM events e WHERE e.agent_phone = l.agent_phone AND e.event = 'APP_OPEN'
          AND (e.ts AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date) AS opens_today
FROM leads l
LEFT JOIN agent_daily d ON d.agent_phone = l.agent_phone AND d.day = (now() AT TIME ZONE 'Asia/Kolkata')::date
GROUP BY l.agent_phone, d.sent_count
ORDER BY sent_today DESC;

-- 3) DUPLICATE CHECK — customers messaged more than once in the last 30 days
--    (should be empty for anything sent through the Railway app)
SELECT cx_phone, count(*) AS times_sent,
       string_agg(agent_phone || ' @ ' || to_char(sent_at AT TIME ZONE 'Asia/Kolkata', 'DD-Mon HH24:MI'), ' | ' ORDER BY sent_at) AS history
FROM leads
WHERE status = 'SENT' AND sent_at > now() - interval '30 days'
GROUP BY cx_phone
HAVING count(*) > 1
ORDER BY times_sent DESC;

-- 4) Blocked attempts (what the new system prevented), by reason and day
SELECT (ts AT TIME ZONE 'Asia/Kolkata')::date AS day, detail AS reason, count(*)
FROM events WHERE event = 'SEND_BLOCKED'
GROUP BY 1, 2 ORDER BY 1 DESC, 3 DESC;

-- 5) Daily trend — sends, active agents, opens (last 30 days)
SELECT (ts AT TIME ZONE 'Asia/Kolkata')::date AS day,
       count(*) FILTER (WHERE event = 'SEND_CLICK')                         AS sends,
       count(DISTINCT agent_phone) FILTER (WHERE event = 'SEND_CLICK')      AS agents_sending,
       count(DISTINCT agent_phone) FILTER (WHERE event = 'APP_OPEN')        AS agents_opened,
       count(*) FILTER (WHERE event = 'LINK_SENT')                          AS links_delivered,
       count(*) FILTER (WHERE event = 'LINK_FAIL')                          AS links_failed
FROM events
WHERE ts > now() - interval '30 days'
GROUP BY 1 ORDER BY 1 DESC;

-- 6) Funnel: link sent → opened app → sent ≥1 msg → hit cap (today)
WITH t AS (SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS d),
e AS (SELECT agent_phone, event FROM events, t WHERE (ts AT TIME ZONE 'Asia/Kolkata')::date = t.d)
SELECT
  count(DISTINCT agent_phone) FILTER (WHERE event = 'LINK_SENT')  AS got_link,
  count(DISTINCT agent_phone) FILTER (WHERE event = 'APP_OPEN')   AS opened,
  count(DISTINCT agent_phone) FILTER (WHERE event = 'SEND_CLICK') AS sent_any,
  (SELECT count(*) FROM agent_daily, t WHERE day = t.d AND sent_count >= 10) AS hit_cap
FROM e;

-- 7) Agents who got the link but never opened (today) — follow-up list
SELECT DISTINCT e.agent_phone, e.agent_name
FROM events e
WHERE e.event = 'LINK_SENT' AND (e.ts AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date
  AND NOT EXISTS (SELECT 1 FROM events o WHERE o.agent_phone = e.agent_phone AND o.event = 'APP_OPEN'
                  AND (o.ts AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date);

-- 8) Month-to-date sends per agent (leaderboard)
SELECT agent_phone, max(agent_name) AS agent_name, count(*) AS sent_mtd
FROM events
WHERE event = 'SEND_CLICK'
  AND (ts AT TIME ZONE 'Asia/Kolkata')::date >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')::date
GROUP BY agent_phone ORDER BY sent_mtd DESC;

-- 9) Oldest overdue leads (stuck in rollover)
SELECT agent_phone, agent_name, cx_phone, cx_name, lead_date,
       (now() AT TIME ZONE 'Asia/Kolkata')::date - lead_date AS days_overdue
FROM leads WHERE status IS NULL AND lead_date < (now() AT TIME ZONE 'Asia/Kolkata')::date
ORDER BY lead_date LIMIT 200;

-- 10) Same customer mapped to multiple agents (source-data quality check)
SELECT cx_phone, count(DISTINCT agent_phone) AS agents, string_agg(DISTINCT agent_phone, ', ') AS agent_list
FROM leads WHERE lead_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - 7
GROUP BY cx_phone HAVING count(DISTINCT agent_phone) > 1
ORDER BY agents DESC;

-- 11) Blast status today (who failed, with Gupshup error)
SELECT agent_phone, ok, detail, ts AT TIME ZONE 'Asia/Kolkata' AS ts_ist
FROM blast_log WHERE day = (now() AT TIME ZONE 'Asia/Kolkata')::date
ORDER BY ok NULLS FIRST, agent_phone;

-- 12) Sync health — events not yet written to the sheet (should stay near 0)
SELECT count(*) AS unsynced_events, min(ts) AS oldest FROM events WHERE synced = false;

-- ============================================================
-- OPS FIXES (run deliberately)
-- ============================================================

-- A) Undo a wrong SENT (e.g. agent tapped but WhatsApp didn't open) — also frees one cap slot
-- BEGIN;
-- UPDATE leads SET status = NULL, sent_at = NULL, updated_at = now() WHERE id = <lead_id> AND status = 'SENT';
-- UPDATE agent_daily SET sent_count = GREATEST(sent_count - 1, 0)
--   WHERE agent_phone = '<agent_phone>' AND day = (now() AT TIME ZONE 'Asia/Kolkata')::date;
-- COMMIT;

-- B) Give one agent extra sends today (raise their cap by 5)
-- UPDATE agent_daily SET sent_count = GREATEST(sent_count - 5, 0)
--   WHERE agent_phone = '<agent_phone>' AND day = (now() AT TIME ZONE 'Asia/Kolkata')::date;

-- C) Close all pending leads for an agent who left
-- UPDATE leads SET status = 'CLOSED', updated_at = now() WHERE agent_phone = '<agent_phone>' AND status IS NULL;

-- D) Re-open a customer that was DUP_SKIPPED by mistake
-- UPDATE leads SET status = NULL, updated_at = now() WHERE id = <lead_id> AND status = 'DUP_SKIPPED';

-- E) Housekeeping — keep events lean (older than 120 days, already synced to sheet)
-- DELETE FROM events WHERE synced = true AND ts < now() - interval '120 days';
