// Server-rendered agent page. Queue data is inlined so the page opens with no extra
// round-trip (important inside WhatsApp's in-app browser).
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
  :root{--grad:linear-gradient(90deg,#DF3C27 0%,#B9266B 50%,#2964A6 100%);--ink:#2B1B1E;--cream:#FCF3E8;--red:#E05227;--gold:#C98208}
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:var(--cream);color:var(--ink)}
  header{background:#fff;padding:12px 16px 10px;display:flex;align-items:center;gap:12px;border-bottom:3px solid transparent;
         border-image:var(--grad) 1}
  header img{height:28px}
  .meta{font-size:12.5px;color:#6b5a5d;margin-top:2px}
  h2{margin:0;font-size:15px}
  .tabs{display:flex;max-width:520px;margin:auto;padding:10px 12px 0;gap:8px}
  .tab{flex:1;border:none;background:#f1e5d6;color:#6b5a5d;font-size:14px;font-weight:700;padding:11px 8px;border-radius:10px 10px 0 0}
  .tab.active{background:#fff;color:#B9266B}
  .wrap{padding:12px;max-width:520px;margin:auto}
  .banner{max-width:520px;margin:8px auto 0;padding:10px 14px;background:#fff;border-left:4px solid var(--gold);
          font-size:13px;font-weight:600;border-radius:8px;display:none}
  .card{background:#fff;border-radius:12px;padding:14px;margin-bottom:12px;box-shadow:0 1px 3px rgba(43,27,30,.08)}
  .tag{display:inline-block;background:#fbeee0;color:var(--gold);font-size:11px;font-weight:700;border-radius:6px;padding:2px 7px;margin-bottom:6px}
  .name{font-weight:600;font-size:16px}
  .phone{color:#6b5a5d;font-size:13px;margin:2px 0 10px}
  .btn{display:block;width:100%;text-align:center;border:none;border-radius:9px;padding:13px;font-size:15px;font-weight:600;text-decoration:none}
  .wa{background:#25d366;color:#fff}
  .done{background:var(--grad);color:#fff;pointer-events:none}
  .disabled{background:#e8e0d8;color:#a39698;pointer-events:none}
  .empty{text-align:center;color:#8a7a7c;padding:40px 16px;line-height:1.6}
  input{width:100%;padding:12px;font-size:16px;border:1px solid #d8c8b8;border-radius:8px}
`;

function page(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>${CSS}</style></head><body>${body}</body></html>`;
}

function loginPage() {
  return page('Rupeek CX Outreach', `
<header><img src="/rupeek-logo.png" alt="Rupeek"><div><h2>CX Outreach</h2><div class="meta">Login</div></div></header>
<div class="wrap"><p>Please open the link sent to you on WhatsApp.</p></div>`);
}

function agentPage(agentParam, data) {
  return page('Rupeek CX Outreach', `
<header><img src="/rupeek-logo.png" alt="Rupeek"><div><h2>CX Outreach</h2><div class="meta" id="meta">Loading…</div></div></header>
<div id="banner" class="banner"></div>
<div class="tabs">
  <button class="tab active" id="tab-today" onclick="showTab('today')">Today</button>
  <button class="tab" id="tab-prev" onclick="showTab('prev')">Previous</button>
</div>
<div class="wrap" id="today"></div>
<div class="wrap" id="prev" style="display:none"></div>
<script>
const AGENT = ${JSON.stringify(agentParam)};
let D = ${JSON.stringify(data).replace(/</g, '\\u003c')};
let TAB = 'today';
const esc = s => String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function card(l, isPrev){
  return '<div class="card" id="c'+l.id+'">'+
    (isPrev ? '<div class="tag">⏳ Pending since '+esc(l.origDate)+'</div>' : '')+
    '<div class="name">'+esc(l.cxName || 'Customer')+'</div>'+
    '<div class="phone">+'+esc(l.cxPhone)+'</div>'+
    // The click is recorded SERVER-SIDE by /go before redirecting to WhatsApp,
    // so it can't be lost even if this page is killed when WhatsApp opens.
    '<a class="btn wa" href="/go/'+l.id+'?agent='+encodeURIComponent(AGENT)+'" target="_blank" rel="noopener" '+
      'onclick="tapped(this,\\''+l.id+'\\')">📲 Send Msg</a></div>';
}
function render(){
  document.getElementById('meta').textContent = (D.agentName || '') + ' · ' + D.date + ' · Sent: ' + D.sentToday + '/' + D.cap;
  document.getElementById('tab-today').textContent = 'Today (' + D.today.length + ')';
  document.getElementById('tab-prev').textContent  = 'Previous (' + D.overdue.length + ')';
  document.getElementById('today').innerHTML = D.today.length ? D.today.map(l => card(l,false)).join('')
    : '<div class="empty">No customers scheduled for today.</div>';
  document.getElementById('prev').innerHTML = D.overdue.length ? D.overdue.map(l => card(l,true)).join('')
    : '<div class="empty">No pending customers from earlier. 🎉</div>';
  applyCap(); showTab(TAB);
}
function showTab(w){
  TAB = w; const p = w === 'prev';
  document.getElementById('today').style.display = p ? 'none' : 'block';
  document.getElementById('prev').style.display  = p ? 'block' : 'none';
  document.getElementById('tab-today').classList.toggle('active', !p);
  document.getElementById('tab-prev').classList.toggle('active', p);
}
function applyCap(){
  const b = document.getElementById('banner');
  if (D.remaining <= 0) {
    document.querySelectorAll('.btn.wa').forEach(x => { x.className = 'btn disabled'; x.removeAttribute('href'); x.textContent = 'Daily limit reached'; });
    b.style.display = 'block'; b.textContent = '✅ Daily limit reached — ' + D.sentToday + '/' + D.cap + '. Come back tomorrow.';
  } else b.style.display = 'none';
}
function tapped(a, id){
  // optimistic UI only; the server is the source of truth
  a.className = 'btn done'; a.textContent = '✔ Opening WhatsApp…';
  setTimeout(() => { const c = document.getElementById('c'+id); if (c) c.remove(); }, 800);
  setTimeout(refresh, 2500);
}
let inflight = false;
function refresh(){
  if (inflight) return; inflight = true;
  fetch('/api/queue?agent=' + encodeURIComponent(AGENT), { cache: 'no-store' })
    .then(r => r.ok ? r.json() : null).then(d => { if (d) { D = d; render(); } })
    .catch(() => {}).finally(() => { inflight = false; });
}
// Coming back from WhatsApp → reload the true state from the server
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
window.addEventListener('pageshow', e => { if (e.persisted) refresh(); });
render();
</script>`);
}

const MSG = {
  already_sent: ['Already sent', 'This customer was already messaged. Go back to your list.'],
  duplicate_cx: ['Already contacted', 'This customer was recently messaged by another agent, so it has been removed from your list.'],
  capped:       ['Daily limit reached', 'You have reached today’s limit. Come back tomorrow.'],
  closed:       ['Lead closed', 'This lead is no longer active.'],
  not_found:    ['Not found', 'This lead is not in your list.'],
  bad_link:     ['Invalid link', 'Please open the latest link sent to you on WhatsApp.']
};
function infoPage(reason, agentParam) {
  const [t, m] = MSG[reason] || ['Something went wrong', 'Please go back and try again.'];
  return page(t, `<header><img src="/rupeek-logo.png" alt="Rupeek"><div><h2>${esc(t)}</h2></div></header>
<div class="wrap"><div class="card"><p>${esc(m)}</p>
${agentParam ? `<a class="btn wa" href="/?agent=${encodeURIComponent(agentParam)}">← Back to my list</a>` : ''}</div></div>`);
}

module.exports = { loginPage, agentPage, infoPage };
