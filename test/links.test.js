// Agent-link delivery per channel (Agents tab), with Gupshup + SMTP stubbed.
//   node test/links.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cxl-'));
process.env.GUPSHUP_API_KEY = 'k'; process.env.TEMPLATE_ID = 't';
process.env.APP_URL = 'https://app.test';
process.env.DEFAULT_CHANNEL = 'WHATSAPP';

const { today } = require('../src/util');
const serial = Date.parse(today() + 'T00:00:00Z') / 86400000 + 25569;

const tabs = {
  Leads: [['cx_phone', 'cx_name', 'mapped_agent_phone', 'agent_name', 'Date'],
    ...['9000000001', '9000000002', '9000000003', '9000000004', '9000000005', '9000000006']
      .map((ag, i) => [9811111100 + i, 'Cx' + i, ag, 'Agent ' + (i + 1), serial])],
  Agents: [['agent_phone', 'agent_name', 'email', 'link_channel'],
    ['9000000002', '', 'two@rupeek.com', 'Email'],
    ['919000000003', '', 'three@rupeek.com', 'both'],
    ['9000000004', '', '', 'NONE'],
    ['9000000005', '', '', 'EMAIL']],                    // email chosen but missing → WhatsApp
  // 9000000006 not in Agents tab → DEFAULT_CHANNEL; 9000000001 too
};
const fake = {
  async read(range) {
    const [tab, a1] = range.split('!');
    const r0 = (+((a1.match(/\d+/) || [1])[0])) - 1;
    return (tabs[tab] || []).slice(r0).filter((r) => r && r.length);
  },
  async batchWrite(d) { d.forEach(({ range, values }) => { const [tab] = range.split('!'); if (!(tabs[tab] || []).length) tabs[tab] = values.slice(); }); },
  async append(range, rows) { const [tab] = range.split('!'); (tabs[tab] = tabs[tab] || []).push(...rows); },
  async clear() {}, async ensureTabs(n) { n.forEach((t) => { tabs[t] = tabs[t] || []; }); },
};
require.cache[require.resolve('../src/sheets')] = { loaded: true, exports: fake };

const sentMail = [];
require.cache[require.resolve('../src/mailer')] = { loaded: true, exports: {
  emailEnabled: () => true,
  async sendLinkEmail(to, a, link) { sentMail.push({ to, phone: a.phone, link }); return { ok: true }; },
} };
const sentWa = [];
global.fetch = async (url, opt) => {
  const p = new URLSearchParams(opt.body.toString());
  sentWa.push({ to: p.get('destination'), params: JSON.parse(p.get('template')).params });
  return { ok: true, status: 200, text: async () => '{"status":"submitted"}' };
};

(async () => {
  const store = require('../src/store');
  const jobs = require('../src/jobs');
  await store.init();

  const out = await jobs.sendAgentLinks();
  console.log('blast:', out);
  const wa = sentWa.map((x) => x.to).sort(), mail = sentMail.map((x) => x.to).sort();
  assert.deepStrictEqual(wa, ['919000000001', '919000000003', '919000000005', '919000000006']);
  assert.deepStrictEqual(mail, ['three@rupeek.com', 'two@rupeek.com']);
  assert.ok(sentMail.every((m) => m.link === 'https://app.test/?agent=' + m.phone));
  assert.deepStrictEqual(sentWa.find((x) => x.to === '919000000001').params, ['Agent 1', '919000000001']);
  assert.ok(/1 set to NONE/.test(out));

  // once a day, even when called again
  assert.ok(/already blasted/.test(await jobs.sendAgentLinks()));

  // one agent, forced to email at a test address
  sentMail.length = 0;
  const r = await jobs.testSend('9000000001', { channel: 'email', email: 'me@rupeek.com' });
  assert.deepStrictEqual(sentMail.map((m) => m.to), ['me@rupeek.com']);
  assert.strictEqual(r.results[0].via, 'email');

  // agents seen in Leads but not in the Agents tab get appended for ops to fill in
  console.log('agents tab:', await store.syncAgentsTab());
  const listed = tabs.Agents.slice(1).map((x) => String(x[0]).replace(/\D/g, '').slice(-10));
  assert.ok(listed.includes('9000000001') && listed.includes('9000000006'));

  console.log('\nALL LINK TESTS PASSED');
})().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
