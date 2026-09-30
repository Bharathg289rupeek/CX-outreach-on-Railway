/******************************************************************
 * 9:30 AM agent link blast via Gupshup.
 * blast_log (agent_phone, day) is claimed BEFORE sending, so a restart or a
 * double trigger can never message the same agent twice in a day.
 ******************************************************************/
const { pool, getAgentName } = require('./db');
const { dashboardRows } = require('./sheets');
const { today, cleanParam, sign } = require('./util');

const NAME_FALLBACK = 'there';

function gupshupBody(agentPhone, agentName) {
  // Template: body {{1}} = agent name, button URL {{1}} = agent param (phone or phone.sig)
  const params = [cleanParam(agentName, NAME_FALLBACK), sign(agentPhone)];
  return new URLSearchParams({
    channel: 'whatsapp',
    source: process.env.GUPSHUP_SOURCE,
    'src.name': process.env.GUPSHUP_APP,
    destination: agentPhone,
    template: JSON.stringify({ id: process.env.GUPSHUP_TEMPLATE_ID, params })
  });
}

async function sendOne(agentPhone, agentName) {
  const res = await fetch('https://api.gupshup.io/wa/api/v1/template/msg', {
    method: 'POST',
    headers: { apikey: process.env.GUPSHUP_API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: gupshupBody(agentPhone, agentName)
  });
  const text = await res.text();
  return { ok: res.status < 300, detail: text.slice(0, 300) };
}

async function sendDailyAgentLinks({ onlyPhone = null } = {}) {
  const td = today();
  const targets = onlyPhone
    ? [{ agent_phone: onlyPhone, agent_name: await getAgentName(onlyPhone) }]   // test send: no filters
    : (await dashboardRows()).filter(x => x.remaining > 0 && (x.fresh_today + x.overdue) > 0);

  let ok = 0, failed = 0, skipped = 0;
  const BATCH = 25;
  for (let i = 0; i < targets.length; i += BATCH) {
    const chunk = targets.slice(i, i + BATCH);
    await Promise.all(chunk.map(async x => {
      // claim the slot first (test sends bypass the claim)
      if (!onlyPhone) {
        const claim = await pool.query(
          `INSERT INTO blast_log (agent_phone, day) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1`, [x.agent_phone, td]);
        if (!claim.rows.length) { skipped++; return; }
      }
      let r;
      try { r = await sendOne(x.agent_phone, x.agent_name); }
      catch (e) { r = { ok: false, detail: String(e.message).slice(0, 300) }; }
      r.ok ? ok++ : failed++;
      if (!onlyPhone) {
        await pool.query(`UPDATE blast_log SET ok=$3, detail=$4, ts=now() WHERE agent_phone=$1 AND day=$2`,
          [x.agent_phone, td, r.ok, r.detail]);
      }
      await pool.query(
        `INSERT INTO events (event, agent_phone, agent_name, detail) VALUES ($1,$2,$3,$4)`,
        [r.ok ? 'LINK_SENT' : 'LINK_FAIL', x.agent_phone, x.agent_name, r.ok ? (onlyPhone ? 'test' : null) : r.detail]);
    }));
    await new Promise(res => setTimeout(res, 400));
  }
  const msg = `blast: ${ok} sent, ${failed} failed, ${skipped} already sent today`;
  console.log('[blast]', msg);
  return msg;
}

module.exports = { sendDailyAgentLinks };
