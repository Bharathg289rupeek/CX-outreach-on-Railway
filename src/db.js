const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { today } = require('./util');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 10),
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined
});

const DAILY_CAP = Number(process.env.DAILY_CAP || 10);
// Don't message the same customer again (from ANY agent) within N days. 0 = off.
const CX_COOLDOWN_DAYS = Number(process.env.CX_COOLDOWN_DAYS || 7);

const DEFAULT_TPL =
`Hi {{cx_name}}, this is {{agent_name}} from Rupeek Gold Loan.
Gold price is dipping, but Rupeek is giving the SAME loan amount at DROPPED interest rates! 📉✨
New reduced monthly rates:
- ₹0–3L: 1.34% ➜ 1.14% (−0.20%)
- ₹3–6L: 1.19% ➜ 0.99% (−0.20%)
- ₹6–12L: 1.04% ➜ 0.89% (−0.15%)
- ₹12L+: 0.94% ➜ 0.79% (−0.15%)
- ₹25L+: 0.89% ➜ 0.75% (−0.14%)
Lock in today's rate before prices move. WhatsApp me or call me!`;

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

async function logEvent(e) {
  await pool.query(
    `INSERT INTO events (event, agent_phone, agent_name, cx_phone, cx_name, lead_id, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [e.event, e.agentPhone || null, e.agentName || null, e.cxPhone || null, e.cxName || null, e.leadId || null, e.detail || null]
  );
}

async function getTemplate() {
  const r = await pool.query(`SELECT value FROM settings WHERE key='msg_template'`);
  return (r.rows[0] && r.rows[0].value.trim()) || DEFAULT_TPL;
}

async function getAgentName(agentPhone) {
  const r = await pool.query(
    `SELECT agent_name FROM leads WHERE agent_phone=$1 AND agent_name<>'' ORDER BY lead_date DESC LIMIT 1`, [agentPhone]);
  return r.rows[0] ? r.rows[0].agent_name : '';
}

// Today's + overdue pending leads for one agent. One card per customer; customers
// messaged by anyone within the cooldown are hidden.
async function getQueue(agentPhone) {
  const td = today();
  const [leads, daily, name] = await Promise.all([
    pool.query(
      `WITH pending AS (
         SELECT DISTINCT ON (l.cx_phone) l.id, l.cx_phone, l.cx_name, l.lead_date
         FROM leads l
         WHERE l.agent_phone = $1
           AND l.status IS NULL
           AND l.lead_date <= $2::date
           AND NOT ($3::int > 0 AND EXISTS (
                 SELECT 1 FROM leads s
                 WHERE s.cx_phone = l.cx_phone AND s.status = 'SENT'
                   AND s.sent_at > now() - make_interval(days => $3::int)))
         ORDER BY l.cx_phone, l.lead_date, l.id
       )
       SELECT id, cx_phone, cx_name, to_char(lead_date,'YYYY-MM-DD') AS lead_date
       FROM pending ORDER BY lead_date, id`,
      [agentPhone, td, CX_COOLDOWN_DAYS]),
    pool.query(`SELECT sent_count FROM agent_daily WHERE agent_phone=$1 AND day=$2`, [agentPhone, td]),
    getAgentName(agentPhone)
  ]);
  const sentToday = daily.rows[0] ? daily.rows[0].sent_count : 0;
  const mk = r => ({ id: String(r.id), cxName: r.cx_name, cxPhone: r.cx_phone, origDate: r.lead_date });
  const todayLeads = leads.rows.filter(r => r.lead_date === td).map(mk);
  const overdue = leads.rows.filter(r => r.lead_date < td).map(mk);
  return {
    agentName: name, date: td, cap: DAILY_CAP, sentToday,
    remaining: Math.max(0, DAILY_CAP - sentToday),
    today: todayLeads, overdue, todayCount: todayLeads.length, overdueCount: overdue.length
  };
}

/**
 * Atomically record a send. Returns:
 *  { ok:true, lead }                       → first and only send, redirect to WhatsApp
 *  { ok:false, reason:'already_sent'|'duplicate_cx'|'capped'|'closed'|'not_found' }
 * Guarantees: a lead is SENT at most once, a customer is messaged at most once per
 * cooldown window (across all agents), and an agent can never exceed DAILY_CAP.
 */
async function recordSend(leadId, agentPhone) {
  const td = today();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pre = await client.query(`SELECT cx_phone FROM leads WHERE id=$1 AND agent_phone=$2`, [leadId, agentPhone]);
    if (!pre.rows.length) { await client.query('ROLLBACK'); return { ok: false, reason: 'not_found' }; }
    const cxPhone = pre.rows[0].cx_phone;

    // Serialize everything touching this customer (two agents tapping the same cx at once)
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('cx:' || $1))`, [cxPhone]);

    const cur = await client.query(
      `SELECT id, cx_phone, cx_name, agent_name, status FROM leads WHERE id=$1 FOR UPDATE`, [leadId]);
    const lead = cur.rows[0];
    if (lead.status === 'SENT') { await client.query('ROLLBACK'); return { ok: false, reason: 'already_sent', lead }; }
    if (lead.status)           { await client.query('ROLLBACK'); return { ok: false, reason: 'closed', lead }; }

    if (CX_COOLDOWN_DAYS > 0) {
      const dup = await client.query(
        `SELECT 1 FROM leads WHERE cx_phone=$1 AND status='SENT'
           AND sent_at > now() - make_interval(days => $2::int) LIMIT 1`, [cxPhone, CX_COOLDOWN_DAYS]);
      if (dup.rows.length) {
        await client.query(`UPDATE leads SET status='DUP_SKIPPED', updated_at=now() WHERE id=$1`, [leadId]);
        await client.query('COMMIT');
        return { ok: false, reason: 'duplicate_cx', lead };
      }
    }

    await client.query(
      `INSERT INTO agent_daily (agent_phone, day, sent_count) VALUES ($1,$2,0) ON CONFLICT DO NOTHING`, [agentPhone, td]);
    const cap = await client.query(
      `UPDATE agent_daily SET sent_count = sent_count + 1
       WHERE agent_phone=$1 AND day=$2 AND sent_count < $3 RETURNING sent_count`, [agentPhone, td, DAILY_CAP]);
    if (!cap.rows.length) { await client.query('ROLLBACK'); return { ok: false, reason: 'capped', lead }; }

    await client.query(`UPDATE leads SET status='SENT', sent_at=now(), updated_at=now() WHERE id=$1`, [leadId]);
    if (CX_COOLDOWN_DAYS > 0) {
      // Close this customer's other pending leads (other dates / other agents)
      await client.query(
        `UPDATE leads SET status='DUP_SKIPPED', updated_at=now()
         WHERE cx_phone=$1 AND status IS NULL AND id<>$2`, [cxPhone, leadId]);
    }
    await client.query(
      `INSERT INTO events (event, agent_phone, agent_name, cx_phone, cx_name, lead_id)
       VALUES ('SEND_CLICK',$1,$2,$3,$4,$5)`, [agentPhone, lead.agent_name, lead.cx_phone, lead.cx_name, leadId]);
    await client.query('COMMIT');
    return { ok: true, lead, sentToday: cap.rows[0].sent_count };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, migrate, logEvent, getTemplate, getAgentName, getQueue, recordSend, DAILY_CAP, CX_COOLDOWN_DAYS, DEFAULT_TPL };
