const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeJson = (o) => JSON.stringify(o).replace(/</g, '\\u003c');

const CSS = `
:root{--grad:linear-gradient(90deg,#DF3C27 0%,#B9266B 50%,#2964A6 100%);--red:#E05227;--gold:#C98208;--cream:#FCF3E8;--ink:#2B1B1E}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:var(--cream);color:var(--ink)}
header{background:var(--grad);color:#fff;padding:12px 16px;display:flex;align-items:center;gap:12px;position:sticky;top:0;z-index:5}
.logo{height:34px;width:34px;border-radius:50%;background:#fff;object-fit:contain;padding:3px;flex:none}
header h2{margin:0;font-size:17px}
.meta{font-size:13px;opacity:.92;margin-top:2px}
.tabs{display:flex;max-width:520px;margin:auto;padding:10px 12px 0;gap:8px}
.tab{flex:1;text-align:center;border:none;background:#efe3d4;color:#6b5a55;font-size:14px;font-weight:700;padding:11px 8px;border-radius:10px 10px 0 0;cursor:pointer}
.tab.active{background:#fff;color:#B9266B;box-shadow:0 -1px 3px rgba(0,0,0,.06)}
.wrap{padding:12px;max-width:520px;margin:auto}
.banner{max-width:520px;margin:8px auto 0;padding:10px 14px;background:#fde8e1;color:#b8321a;font-size:13px;font-weight:600;border-radius:9px;text-align:center;display:none}
.card{background:#fff;border-radius:12px;padding:14px;margin-bottom:12px;box-shadow:0 1px 3px rgba(43,27,30,.08);transition:opacity .3s}
.tag{display:inline-block;background:#fbeed6;color:var(--gold);font-size:11px;font-weight:700;border-radius:6px;padding:2px 7px;margin-bottom:6px}
.name{font-weight:600;font-size:16px}
.phone{color:#7a6a66;font-size:13px;margin:2px 0 10px}
.btn{display:block;width:100%;text-align:center;border:none;border-radius:9px;padding:13px;font-size:15px;font-weight:600;cursor:pointer;text-decoration:none}
.wa{background:#25d366;color:#fff}
.sentbtn{background:var(--grad);color:#fff;pointer-events:none}
.disabled{background:#e6ddd3;color:#a3958f;pointer-events:none}
.empty{text-align:center;color:#8a7a75;padding:40px 16px;line-height:1.6}
input{width:100%;padding:12px;font-size:16px;border:1px solid #d9cabb;border-radius:8px;background:#fff}
.info{max-width:460px;margin:40px auto;padding:24px;background:#fff;border-radius:14px;text-align:center;box-shadow:0 1px 3px rgba(43,27,30,.08)}
.info h3{margin:6px 0 10px}.info p{color:#6b5a55;line-height:1.5}
.icon{font-size:40px}
`;

function page(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body>
<header><img class="logo" src="/logo.png" alt="Rupeek"><div><h2>Rupeek CX Outreach</h2><div class="meta" id="meta">${esc(title)}</div></div></header>
${body}</body></html>`;
}

function renderApp(agent, data) {
  if (!agent) {
    return page('Login', `<div class="wrap"><div class="info">
<p>Enter your WhatsApp number:</p><input id="aid" type="tel" placeholder="98XXXXXXXX"><br><br>
<button class="btn wa" onclick="var v=document.getElementById('aid').value.replace(/\\D/g,'');if(v)location.href='/?agent='+v">Continue</button>
</div></div>`);
  }
  return page('Loading…', `
<div id="banner" class="banner"></div>
<div id="tabbar" class="tabs">
  <button class="tab active" id="tab-today" onclick="showTab('today')">Today</button>
  <button class="tab" id="tab-prev" onclick="showTab('prev')">Previous</button>
</div>
<div class="wrap" id="today"></div>
<div class="wrap" id="prev" style="display:none"></div>
<script>
const AGENT = ${safeJson(agent)};
const INITIAL = ${safeJson(data)};
const STATE = { agentName:'', date:'', cap:10, sentToday:0, remaining:10, tab:'today', clicked:{} };
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

function card(l, isPrev){
  return '<div class="card" id="c'+l.id+'">'+
    (isPrev ? '<div class="tag">⏳ Pending since '+esc(l.origDate)+'</div><br>' : '')+
    '<div class="name">'+esc(l.cxName)+'</div>'+
    '<div class="phone">+'+esc(l.cxPhone)+'</div>'+
    // The tap goes to OUR server first: it records SENT, then hands off to WhatsApp.
    '<a class="btn wa" id="b'+l.id+'" href="/s/'+encodeURIComponent(l.id)+'?agent='+encodeURIComponent(AGENT)+'" '+
      'target="_blank" rel="noopener" onclick="return sent(\\''+l.id+'\\')">📲 Send Msg</a>'+
  '</div>';
}

function render(d){
  STATE.agentName = d.agentName || AGENT; STATE.date = d.date; STATE.cap = d.cap;
  STATE.sentToday = d.sentToday; STATE.remaining = d.remaining;
  updateMeta();
  const today = (d.today||[]).filter(l=>!STATE.clicked[l.id]), prev = (d.overdue||[]).filter(l=>!STATE.clicked[l.id]);
  document.getElementById('tab-today').textContent = 'Today (' + today.length + ')';
  document.getElementById('tab-prev').textContent  = 'Previous (' + prev.length + ')';
  document.getElementById('today').innerHTML = today.length ? today.map(l=>card(l,false)).join('') : '<div class="empty">No customers scheduled for today.</div>';
  document.getElementById('prev').innerHTML  = prev.length  ? prev.map(l=>card(l,true)).join('')   : '<div class="empty">No pending customers from earlier. 🎉</div>';
  applyCap(); showTab(STATE.tab);
}

function showTab(w){
  STATE.tab = w; const p = w === 'prev';
  document.getElementById('today').style.display = p ? 'none' : 'block';
  document.getElementById('prev').style.display  = p ? 'block' : 'none';
  document.getElementById('tab-today').classList.toggle('active', !p);
  document.getElementById('tab-prev').classList.toggle('active', p);
}

function applyCap(){
  const banner = document.getElementById('banner');
  if (STATE.remaining <= 0){
    document.querySelectorAll('.btn.wa').forEach(b=>{ b.classList.remove('wa'); b.classList.add('disabled'); b.removeAttribute('href'); b.textContent='Daily limit reached'; });
    banner.style.display='block'; banner.textContent='✅ Daily limit reached — '+STATE.sentToday+'/'+STATE.cap+'. Come back tomorrow.';
  } else banner.style.display='none';
}

function sent(id){
  if (STATE.remaining <= 0 || STATE.clicked[id]) return false;
  STATE.clicked[id] = 1;
  const b = document.getElementById('b'+id);
  // let the navigation start first, then lock the button so a double-tap can't fire twice
  setTimeout(()=>{ if(b){ b.classList.remove('wa'); b.classList.add('sentbtn'); b.textContent='✔ Sent'; } }, 0);
  STATE.sentToday++; STATE.remaining--; updateMeta();
  setTimeout(()=>{
    const c = document.getElementById('c'+id); if (c) c.remove();
    ['today','prev'].forEach(k=>{ const box=document.getElementById(k);
      if (!box.querySelectorAll('.card').length && !box.querySelector('.empty')) box.innerHTML='<div class="empty">✅ All done here.<br>Check the other tab.</div>'; });
    applyCap();
  }, 700);
  setTimeout(refresh, 2500);
  return true;
}

let busy = false;
async function refresh(){
  if (busy) return; busy = true;
  try { const r = await fetch('/api/queue?agent='+encodeURIComponent(AGENT), {cache:'no-store'});
        if (r.ok){ STATE.clicked = {}; render(await r.json()); } } catch(e){} finally { busy = false; }
}
// server is the truth: re-sync whenever the agent comes back from WhatsApp
document.addEventListener('visibilitychange', ()=>{ if (document.visibilityState === 'visible') refresh(); });

function updateMeta(){ document.getElementById('meta').textContent = (STATE.agentName||AGENT)+' · '+STATE.date+' · Sent: '+STATE.sentToday+'/'+STATE.cap; }
render(INITIAL);
</script>`);
}

// Shown for a split second after a successful claim: auto-opens WhatsApp,
// with a big button as fallback if the in-app browser blocks the auto-open.
function renderHandoff(waLink, lead) {
  const link = esc(waLink);
  return page('Opening WhatsApp…', `<div class="info">
<div class="icon">📲</div><h3>Opening WhatsApp…</h3>
<p>Message to <b>${esc(lead.cxName || 'customer')}</b> (+${esc(lead.cxPhone)}) is recorded as sent.</p>
<a class="btn wa" href="${link}">Tap here if WhatsApp didn't open</a>
</div><script>setTimeout(function(){location.replace(${safeJson(waLink)})},150)</script>`);
}

// Same agent tapped a lead they sent a few minutes ago: WhatsApp may not have opened.
// No auto-open here — the agent must confirm, so an accidental double tap does nothing.
function renderReopen(waLink, lead, agent) {
  return page('Already recorded', `<div class="info">
<div class="icon">✅</div><h3>Already recorded as sent</h3>
<p>Message to <b>${esc(lead.cxName || 'customer')}</b> (+${esc(lead.cxPhone)}) is already counted.</p>
<p><b>Only if WhatsApp did not open</b>, or you did not press send, open it again:</p>
<a class="btn wa" href="${esc(waLink)}">Open WhatsApp again</a>
<a class="btn disabled" style="pointer-events:auto;margin-top:10px;color:#6b5a55" href="/?agent=${encodeURIComponent(agent)}">Back to my list</a>
</div>`);
}

function renderInfo(icon, title, msg, agent) {
  const back = agent ? `<a class="btn wa" href="/?agent=${encodeURIComponent(agent)}" style="margin-top:14px">Back to my list</a>` : '';
  return page(title, `<div class="info"><div class="icon">${icon}</div><h3>${esc(title)}</h3><p>${msg}</p>${back}</div>`);
}

module.exports = { renderApp, renderHandoff, renderReopen, renderInfo, esc };
