/* Bull shared bundle — built from the single-file console. Loaded by every page. */
const SHELL = "<div class=\"facets\"></div>\n<div class=\"marble\" aria-hidden=\"true\"><svg viewBox=\"0 0 1200 800\" preserveAspectRatio=\"xMidYMid slice\" xmlns=\"http://www.w3.org/2000/svg\"><g fill=\"none\" stroke-linecap=\"round\"><path d=\"M-30,130 C220,60 380,230 580,150 S940,40 1260,180\" stroke=\"#8a8068\" stroke-width=\"1.3\" opacity=\".5\"/><path d=\"M-30,250 C150,300 320,210 470,250\" stroke=\"#9a907a\" stroke-width=\".6\" opacity=\".3\"/><path d=\"M-30,372 C260,300 430,452 720,360 S1040,300 1260,432\" stroke=\"#9a907a\" stroke-width=\"1.05\" opacity=\".42\"/><path d=\"M-30,610 C230,560 470,690 740,600 S1020,540 1260,652\" stroke=\"#7d7458\" stroke-width=\"1.5\" opacity=\".46\"/><path d=\"M150,-30 C90,210 240,372 170,572 S250,780 190,840\" stroke=\"#8a8068\" stroke-width=\".85\" opacity=\".34\"/><path d=\"M920,-30 C870,190 1000,360 940,560 S1020,780 980,840\" stroke=\"#9a907a\" stroke-width=\".85\" opacity=\".3\"/><path d=\"M-30,255 C260,215 440,302 650,250 S990,205 1260,300\" stroke=\"#b8932f\" stroke-width=\".7\" opacity=\".24\"/><path d=\"M380,-30 C420,160 320,322 420,520 S360,760 430,840\" stroke=\"#b8932f\" stroke-width=\".55\" opacity=\".16\"/></g></svg></div>\n<div class=\"frame\" aria-hidden=\"true\"><span class=\"cnr tl\">◆</span><span class=\"cnr tr\">◆</span><span class=\"cnr bl\">◆</span><span class=\"cnr br\">◆</span></div>\n<div class=\"wrap\">\n  <header>\n    <div class=\"brand\">\n      <span class=\"mark\" aria-hidden=\"true\">◆</span>\n      <div class=\"switch\">\n        <div class=\"title\" id=\"brandbtn\" title=\"Switch hub\">Bull <span class=\"caret\" aria-hidden=\"true\">▾</span></div>\n        <div class=\"subtitle\" id=\"subtitle\">Autonomous trader · <span id=\"sampleBadge\"></span></div>\n        <div class=\"switchmenu\" id=\"switchmenu\"><!-- built from SITES[] in JS — add a hub there, no markup changes --></div>\n      </div>\n    </div>\n    <div class=\"hmeta\">\n      <span class=\"live\"><span class=\"gem\"></span><span id=\"botstate\">RUNNING</span></span>\n      <span class=\"pill\" id=\"profile\">Aggressive</span><span class=\"pill paper\" id=\"acct\">Paper account</span>\n      <span class=\"pill warn\" id=\"regime\">—</span>\n      <span class=\"updated\" id=\"updlbl\"></span>\n      <span class=\"refresh\" id=\"reload\" title=\"Pull latest bot data\">↻ Refresh</span>\n    </div>\n  </header>\n  <h1 id=\"pgh1\" class=\"sronly\">Bull</h1>\n  <nav class=\"tabs\" id=\"tabs\" aria-label=\"Sections\"></nav>\n  <main id=\"main\"></main>\n</div>\n<div class=\"botbtn\" id=\"botbtn\" role=\"img\" aria-label=\"Bull is a read-only trading console (paper account)\" title=\"Bull — read-only trading console (paper account)\">◆</div>";
document.body.insertAdjacentHTML("afterbegin", SHELL);
document.body.insertAdjacentHTML("beforeend", '<div id="embedModal" class="embedModal" aria-hidden="true"></div>');
/* Tabular figures everywhere numbers are shown — keeps stats strips and tables aligned. */
document.head.insertAdjacentHTML("beforeend", '<style>.val,.kpi .val,table,.tkprice,.tkmeta .b b,.grade,.score,.num,.dimn b,.note b{font-variant-numeric:tabular-nums}</style>');

/* ---------- helpers ---------- */
const up=n=>n>=0,cls=n=>up(n)?'up':'dn',pc=n=>(up(n)?'+':'')+Number(n||0).toFixed(1)+'%',usd=n=>'$'+Math.round(n||0).toLocaleString(),usd2=n=>'$'+Number(n||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
const $=s=>document.querySelector(s),esc=s=>(''+s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const PAGEFILE={overview:'index.html',positions:'positions.html',blotter:'blotter.html',journal:'journal.html',risk:'risk.html',strategy:'strategy.html',movers:'movers.html'};
function pageHref(v){return PAGEFILE[v]||'index.html';}
/* MPA navigation — each tab is a real page (whole-screen change). */
function go(r){const i=(''+r).indexOf('/');const v=i<0?r:r.slice(0,i),p=i<0?'':r.slice(i+1);if(v==='ticker'){location.href='ticker.html?sym='+encodeURIComponent(p);return;}location.href=pageHref(v);}
function prefetchTabs(){document.querySelectorAll('#tabs a[href]').forEach(a=>a.addEventListener('mouseenter',function pf(){const l=document.createElement('link');l.rel='prefetch';l.href=a.href;document.head.appendChild(l);a.removeEventListener('mouseenter',pf);}));}
function tk(t){return `<span class="tk" onclick="event.stopPropagation();go('ticker/${t}')"><b>${t}</b></span>`;}
function curve(a,w,h,col){if(!a||!a.length)return '';const v=a.map(x=>typeof x==='object'?x.v:x);const mn=Math.min(...v),mx=Math.max(...v),r=(mx-mn)||1;col=col||(v[v.length-1]>=v[0]?'#1a7a4e':'#b3263b');const pcS=v[0]?((v[v.length-1]-v[0])/Math.abs(v[0])*100):0;const d=v.map((x,i)=>(i?'L':'M')+(i/(v.length-1)*w).toFixed(1)+','+(h-(x-mn)/r*h).toFixed(1)).join(' ');const area=d+` L${w},${h} L0,${h} Z`;return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img" aria-label="Trend line, ${up(pcS)?'up':'down'} ${Math.abs(pcS).toFixed(1)}%"><defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".2"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs><path d="${area}" fill="url(#bg)"/><path d="${d}" fill="none" stroke="${col}" stroke-width="2"/></svg>`;}
/* Dual-line overlay — gold = you, muted = S&P. Both series rebased to 100 and drawn on shared min/max axes. */
function curve2(you,spy,w,h){const a=(you||[]).map(x=>typeof x==='object'?x.v:x),b=(spy||[]).map(x=>typeof x==='object'?x.v:x);if(a.length<2&&b.length<2)return '<div class="dimn">Curve populates as Bull trades.</div>';const ar=a[0]?a.map(x=>x/a[0]*100):[],br=b.length?b:[];const all=ar.concat(br);const mn=Math.min(...all),mx=Math.max(...all),r=(mx-mn)||1;const gid='cg'+(curve2._n=(curve2._n||0)+1);const path=arr=>arr.map((x,i)=>(i?'L':'M')+(i/(Math.max(1,arr.length-1))*w).toFixed(1)+','+(h-(x-mn)/r*h).toFixed(1)).join(' ');const dy=path(ar),db=path(br);const dyArea=ar.length?dy+` L${w},${h} L0,${h} Z`:'';const yEnd=ar.length?ar[ar.length-1]:100,bEnd=br.length?br[br.length-1]:100;return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img" aria-label="You vs S&P, you ${(yEnd-100).toFixed(1)}% / S&P ${(bEnd-100).toFixed(1)}% over the window"><defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--gold)" stop-opacity=".22"/><stop offset="1" stop-color="var(--gold)" stop-opacity="0"/></linearGradient></defs>${dyArea?`<path d="${dyArea}" fill="url(#${gid})"/>`:''}${db?`<path d="${db}" fill="none" stroke="#b0a890" stroke-width="1.8" stroke-dasharray="5 4"/>`:''}${dy?`<path d="${dy}" fill="none" stroke="var(--gold)" stroke-width="2.2"/>`:''}</svg>`;}

/* ---------- live chart (Stooq, graceful fallback) ---------- */
const chartCache={};
async function loadHistory(sym){if(chartCache[sym]!==undefined)return chartCache[sym];try{const r=await fetch('https://stooq.com/q/d/l/?s='+sym.toLowerCase()+'.us&i=d');const t=await r.text();if(!t||t.indexOf('Date')!==0)throw 0;const rows=t.trim().split('\n').slice(1).map(l=>{const c=l.split(',');return {d:c[0],v:+c[4]}}).filter(x=>x.v>0);if(rows.length<5)throw 0;chartCache[sym]=rows;return rows;}catch(e){chartCache[sym]=null;return null;}}
const RANGES={'1M':22,'6M':126,'YTD':0,'1Y':252,'5Y':1260,'MAX':99999};
function sliceRange(rows,r){if(!rows)return null;if(r==='YTD'){const y=new Date().getFullYear();return rows.filter(x=>+x.d.slice(0,4)===y);}return rows.slice(-(RANGES[r]||rows.length));}
async function renderChart(host,sym,fallback){
  const ranges=['1M','6M','YTD','1Y','5Y','MAX'];let cur='6M';
  host.innerHTML=`<div class="tabs" style="margin-bottom:10px">${ranges.map(r=>`<span class="tab ${r===cur?'active':''}" data-r="${r}">${r}</span>`).join('')}</div><div id="cw" style="height:210px"></div>`;
  const rows=await loadHistory(sym);
  function draw(){const cw=host.querySelector('#cw');let m=sliceRange(rows,cur);if(!m||!m.length){m=(fallback||[]).map(v=>({d:'',v}));}if(!m.length){cw.innerHTML='<div class="dimn">No price history.</div>';return;}cw.innerHTML=curve(m,760,200,m[m.length-1].v>=m[0].v?'#1a7a4e':'#b3263b');const lab=$('#rangelbl');if(lab){const ch=(m[m.length-1].v/m[0].v-1)*100;lab.innerHTML=`<span class="${cls(ch)}">${pc(ch)}</span> ${cur}`;}}
  host.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{cur=b.dataset.r;host.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));b.classList.add('active');draw();});
  draw();
  if(!rows)host.insertAdjacentHTML('beforeend','<div class="dimn" style="margin-top:6px">Live history unavailable here — showing recent trend. Charts populate fully on the deployed site.</div>');
}

/* ---------- state ---------- */
let DATA={};
const card=(title,hint,body)=>`<div class="card"><div class="ctitle">${title}${hint?`<span class="hint">${hint}</span>`:''}</div>${body}</div>`;
const kpi=(lab,val,cl,hint)=>`<div class="kpi">${hint?`<span class="hint">${hint}</span>`:''}<div class="lab">${lab}</div><div class="val ${cl||''}">${val}</div></div>`;

/* ---------- sortable table ---------- */
function tableSort(rows,cols,renderRow,initKey){let k=initKey||cols[0].k,dir=-1;const wrap=document.createElement('div');
  function render(){rows.sort((a,b)=>{let x=a[k],y=b[k];if(typeof x==='string')return dir*(''+x).localeCompare(''+y);return dir*((x||0)-(y||0));});
    wrap.innerHTML=`<table><thead><tr>${cols.map(c=>`<th data-k="${c.k}">${c.h}${c.k===k?(dir<0?' ▾':' ▴'):''}</th>`).join('')}</tr></thead><tbody>${rows.map(renderRow).join('')}</tbody></table>`;
    wrap.querySelectorAll('th').forEach(th=>th.onclick=()=>{const nk=th.dataset.k;if(nk===k)dir=-dir;else{k=nk;dir=-1;}render();});}
  render();return wrap;}

/* ---------- a11y: make div/span controls keyboard-operable; rows focusable but keep table semantics ---------- */
const A11Y_SEL='[onclick]:not(a):not(button):not(input):not(select):not(textarea):not(tr),th[data-k],.tk,.clk,.ctrlbtn,.lnk,.back,.refresh,.embedX,.embedExt,.tab[data-r],#brandbtn';
const A11Y_ROW='tbody tr[onclick]';
function enhA(el){if(el.tabIndex<0)el.tabIndex=0;if(!el.hasAttribute('role'))el.setAttribute('role','button');}
function enhRow(el){if(el.tabIndex<0)el.tabIndex=0;}
function enhanceA11y(root){if(!root||root.nodeType!==1)return;try{if(root.matches){if(root.matches(A11Y_SEL))enhA(root);if(root.matches(A11Y_ROW))enhRow(root);}root.querySelectorAll(A11Y_SEL).forEach(enhA);root.querySelectorAll(A11Y_ROW).forEach(enhRow);}catch(e){}}
document.addEventListener('keydown',e=>{if(e.key!=='Enter'&&e.key!==' ')return;const t=e.target;if(!t||!t.matches)return;if(t.matches('a,button,input,select,textarea'))return;if(t.matches('[role=button],tbody tr[onclick]')){e.preventDefault();t.click();}});
new MutationObserver(muts=>{for(const m of muts)for(const n of m.addedNodes)if(n.nodeType===1)enhanceA11y(n);}).observe(document.body,{childList:true,subtree:true});
enhanceA11y(document.body);
/* a11y: dialog focus management for the embed overlay */
let _modalReturn=null;
function focusables(el){return [...el.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"]),[role=button]')].filter(n=>n.offsetParent!==null);}
function openModalA11y(win,label){if(!win)return;win.setAttribute('role','dialog');win.setAttribute('aria-modal','true');if(label)win.setAttribute('aria-label',label);_modalReturn=document.activeElement;const f=focusables(win);(f[0]||win).focus&&(f[0]||win).focus();
  win._trap=e=>{if(e.key!=='Tab')return;const fz=focusables(win);if(!fz.length)return;const first=fz[0],last=fz[fz.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}};
  win.addEventListener('keydown',win._trap);}
function closeModalA11y(win){if(win&&win._trap){win.removeEventListener('keydown',win._trap);win._trap=null;}if(_modalReturn&&_modalReturn.focus)_modalReturn.focus();_modalReturn=null;}

/* ============ ROUTER ============ */
const TABS=[['overview','Overview'],['positions','Positions'],['blotter','Blotter'],['journal','Journal'],['risk','Risk'],['strategy','Strategy'],['movers','Movers']];
function setTabs(active){$('#tabs').innerHTML=TABS.map(t=>`<a class="tab ${t[0]===active?'active':''}" href="${pageHref(t[0])}">${t[1]}</a>`).join('');prefetchTabs();}
const H1={overview:'Overview',positions:'Positions',blotter:'Blotter',journal:'Journal',risk:'Risk',strategy:'Strategy',movers:'Movers'};
function setH1(t){const h=$('#pgh1');if(h)h.textContent=t||'Bull';}
function route(){const main=$('#main');if(!DATA||!DATA.equity){main.innerHTML=card('Serve me','','<div class="note">Live data loads when this page is <b>served</b> (Netlify or a local web server). Opening the file directly (file://) blocks data fetching.</div>');return;}
  const view=document.body.dataset.page||'overview';const h=[view,new URLSearchParams(location.search).get('sym')];
  if(view==='ticker'){setH1((h[1]||'')+' · ticker');renderTicker(h[1]);setTabs('positions');window.scrollTo(0,0);return;}
  const pages={overview:pgOverview,positions:pgPositions,blotter:pgBlotter,journal:pgJournal,risk:pgRisk,strategy:pgStrategy,movers:pgMovers};
  setH1(H1[view]||'Bull');setTabs(view);main.innerHTML=(pages[view]||pgOverview)();window.scrollTo(0,0);mountDeferred();}
window.addEventListener('hashchange',route);
let deferred=[];function mountDeferred(){deferred.forEach(f=>f());deferred=[];}

/* ============ PAGES ============ */
function pgOverview(){const d=DATA,b=d.bot||{},s=d.stats||{};
  deferred.push(()=>{const el=$('#ovpos');if(el)el.appendChild(posTable(d.positions||[]));});
  return `<div class="kpis">
    ${kpi('Equity',usd(d.equity),'',d.profile)}
    ${kpi('Day P&L',pc(d.dayPnlPct),cls(d.dayPnlPct),d.dayPnlUsd!=null?(d.dayPnlUsd>=0?'+':'')+usd(Math.abs(d.dayPnlUsd)):'')}
    ${kpi('Month P&L',pc(d.monthPnlPct),cls(d.monthPnlPct))}
    ${kpi('vs S&P',pc(d.vsSpyPct),cls(d.vsSpyPct))}
  </div>
  ${perfStrip(d)}
  <div class="grid2">
    ${youVsSpy(d)}
    ${card('Bot health',b.status||'—',`<div class="grid2" style="gap:10px"><div>
       <div class="dimn">Status</div><div class="note"><span class="pill2 ${b.status==='Running'?'green':b.status==='Paused'?'amber':'red'}">${b.status||'—'}</span></div>
       <div class="dimn" style="margin-top:8px">Uptime</div><div class="note">${b.uptime||'—'}</div>
       <div class="dimn" style="margin-top:8px">Version</div><div class="note">${b.version||'—'}</div>
     </div><div>
       <div class="dimn">Last run</div><div class="note">${b.lastRun||'—'}</div>
       <div class="dimn" style="margin-top:8px">Next run</div><div class="note">${b.nextRun||'—'}</div>
       <div class="dimn" style="margin-top:8px">Heartbeat</div><div class="heart">${(b.heartbeat||[]).map(v=>`<span style="height:${Math.max(4,v*22)}px"></span>`).join('')}</div>
     </div></div>`)}
  </div>
  <div class="grid3">
    ${card('Win rate','',`<div class="val" style="font-family:var(--num);font-size:30px">${s.winRate||0}%</div><div class="dimn">${s.trades||0} trades · ${s.wins||0}W / ${s.losses||0}L</div>`)}
    ${card('Profit factor','',`<div class="val" style="font-family:var(--num);font-size:30px">${s.profitFactor||'—'}</div><div class="dimn">Avg win ${pc(s.avgWin||0)} · avg loss ${pc(s.avgLoss||0)}</div>`)}
    ${card('Sharpe','annualised',`<div class="val" style="font-family:var(--num);font-size:30px">${s.sharpe||'—'}</div><div class="dimn">Cash ${usd(d.cash)} · BP ${usd(d.buyingPower)}</div>`)}
  </div>
  ${card('Control panel','UI preview — guardrailed, no live orders','<div class="ctrl">'+
     '<div class="ctrlbtn run" onclick="ctrlMsg(this,\'Run requested — the live agent runs on its Claude Code routine, not from this page.\')">▶ Run now</div>'+
     '<div class="ctrlbtn pause" onclick="ctrlMsg(this,\'Pause flag set (preview). Wire to the routine to take effect.\')">❚❚ Pause bot</div>'+
     '<div class="ctrlbtn kill" onclick="ctrlMsg(this,\'Kill-switch is a hard guardrail — only CJ can flip the live profile.\')">✕ Kill-switch</div>'+
     '</div>'+
     '<div class="slider"><label>Risk per trade — <b id="rl">'+((d.caps||{}).riskPerTrade||10)+'%</b> (cap '+((d.caps||{}).riskPerTrade||10)+'%)</label><input type="range" aria-label="Risk per trade percent" min="1" max="'+((d.caps||{}).riskPerTrade||10)+'" value="'+((d.caps||{}).riskPerTrade||10)+'" oninput="document.getElementById(\'rl\').textContent=this.value+\'%\'"></div>'+
     '<div class="dimn" id="ctrlnote">These controls are a console preview. Execution happens in the Bull agent\'s Claude Code routine (paper only); this page is the monitor.</div>')}
  <div class="grid2">
    ${card('Open positions','sortable · click a row → detail','<div id="ovpos"></div>')}
    ${card('Recent fills','last orders',fillsMini(d.fills||[]))}
  </div>
  ${proposalsCard(d.proposals)}`;
}
function ctrlMsg(el,msg){const n=$('#ctrlnote');if(n){n.textContent=msg;el.style.opacity=.5;setTimeout(()=>el.style.opacity=1,400);}}

function posTable(P){return tableSort(P.map(x=>Object.assign({},x)),[{k:'t',h:'Sym'},{k:'qty',h:'Qty'},{k:'price',h:'Last'},{k:'mktVal',h:'Value'},{k:'unrealPct',h:'P&L%'},{k:'dayPct',h:'Day'}],
  p=>`<tr onclick="go('ticker/${p.t}')"><td>${p.t}${p.lev?'<span class="tag">'+p.lev+'</span>':''}</td><td>${p.qty}</td><td>$${(+p.price).toFixed(2)}</td><td>${usd(p.mktVal)}</td><td class="${cls(p.unrealPct)}">${pc(p.unrealPct)}</td><td class="${cls(p.dayPct)}">${pc(p.dayPct)}</td></tr>`,'mktVal');}
function fillsMini(F){if(!F||!F.length)return '<div class="dimn">No fills yet — orders appear here as Bull trades.</div>';return `<table><thead><tr><th>Time</th><th>Sym</th><th>Side</th><th>Qty</th><th>Price</th></tr></thead><tbody>${F.slice(0,7).map(f=>`<tr onclick="go('ticker/${f.t}')"><td>${f.time}</td><td>${f.t}</td><td class="${f.side==='Buy'?'up':'dn'}">${f.side}</td><td>${f.qty}</td><td>$${(+f.price).toFixed(2)}</td></tr>`).join('')}</tbody></table>`;}

/* ---- new-field renderers ---- */
const num=n=>Number(n||0).toLocaleString(undefined,{maximumFractionDigits:2});
const statCell=(lab,val,cl)=>`<div class="kpi" style="padding:13px 15px"><div class="lab">${lab}</div><div class="val ${cl||''}" style="font-size:23px">${val}</div></div>`;
/* Performance-stats strip — expectancy, profit factor, win rate, Sharpe, max DD, vs-SPY. Empty state when no closed trades. */
function perfStrip(d){const s=d.stats||{},r=d.risk||{};
  if(!s.trades){return card('Performance','metrics populate as Bull trades','<div class="note" style="text-align:center;padding:18px 8px;color:var(--mut)"><div style="font-family:var(--num);font-size:20px;color:var(--goldd);margin-bottom:4px">No closed trades yet</div><div class="dimn">Win rate, expectancy, profit factor, Sharpe and the rest fill in automatically as Bill closes positions.</div></div>');}
  const dd=r.maxDD||0;
  return card('Performance','realised, since inception',`<div class="kpis" style="grid-template-columns:repeat(6,1fr);margin-bottom:0">
    ${statCell('Expectancy',(s.expectancy>=0?'+':'')+usd2(s.expectancy),cls(s.expectancy))}
    ${statCell('Profit factor',num(s.profitFactor),up(s.profitFactor-1)?'up':'dn')}
    ${statCell('Win rate',(s.winRate||0)+'%')}
    ${statCell('Sharpe',num(s.sharpe),up(s.sharpe)?'up':'dn')}
    ${statCell('Max DD','-'+Math.abs(dd)+'%','dn')}
    ${statCell('vs S&P',pc(d.vsSpyPct),cls(d.vsSpyPct))}
  </div><div class="dimn" style="margin-top:10px">${s.trades} trades · ${s.wins||0}W / ${s.losses||0}L · avg R ${num(s.avgR)} · Sortino ${num(s.sortino)} · Calmar ${num(s.calmar)}</div>`);}
/* You vs S&P overlay card — equityCurve rebased to 100 vs spyCurve (already 100-based). */
function youVsSpy(d){const eq=d.equityCurve||[],spy=d.spyCurve||[];
  const yEnd=eq.length&&eq[0]?eq[eq.length-1]/eq[0]*100-100:0,bEnd=spy.length?spy[spy.length-1]-100:0;
  const leg=`<span class="leg"><span class="d blue"></span>You ${(yEnd>=0?'+':'')+yEnd.toFixed(1)}% &nbsp; <span class="d gray"></span>S&P ${(bEnd>=0?'+':'')+bEnd.toFixed(1)}%</span>`;
  return `<div class="card"><div class="ctitle">You vs S&amp;P${leg}</div>${curve2(eq,spy,680,170)}</div>`;}
/* Readiness gate — paper→live checklist. */
function readinessCard(rd){if(!rd)return '';const ok=rd.ready;
  const rows=(rd.checks||[]).map(c=>`<div class="barrow" style="gap:12px;align-items:flex-start"><span style="width:18px;font-family:var(--num);font-weight:600;color:${c.pass?'var(--emer)':'var(--ruby)'}">${c.pass?'✓':'✗'}</span><div style="flex:1"><div class="note" style="font-size:13.5px">${esc(c.label)}</div><div class="dimn">${esc(c.detail||'')}</div></div></div>`).join('');
  const hint=`<span class="pill2 ${ok?'green':'amber'}">${rd.passed||0}/${rd.total||0} · ${ok?'READY':'NOT READY'}</span>`;
  return `<div class="card"><div class="ctitle">Readiness gate<span class="hint">paper → live checklist</span></div>${rows}<div class="dimn" style="margin-top:10px;display:flex;align-items:center;gap:8px">${hint} ${ok?'All gates cleared — promotion still requires CJ\'s written opt-in.':'Live profile stays locked until every gate clears.'}</div></div>`;}
/* Alerts banner — amber if present (red if any look like a halt/kill). */
function alertsBanner(al){if(!al||!al.length)return '';const danger=al.some(a=>/halt|kill|stop|breach|loss/i.test(a));const c=danger?'red':'amber',bg=danger?'var(--rubybg)':'rgba(176,125,24,.12)',bd=danger?'var(--ruby)':'var(--amber)';
  return `<div class="card" style="background:${bg};border-color:transparent;background:${bg} padding-box,var(--goldrim) border-box" role="alert"><div class="ctitle" style="color:${bd}">Alerts <span class="pill2 ${c}">${al.length}</span></div>${al.map(a=>`<div class="note" style="margin:3px 0">• ${esc(a)}</div>`).join('')}</div>`;}
/* Proposals widget — recent agent proposals with status / confidence / setup. */
function proposalsCard(p){p=p||{};const recent=p.recent||[];
  const hint=`<span class="hint">${p.proposed||p.total||0} proposed · ${p.rejected||0} rejected</span>`;
  if(!recent.length)return `<div class="card"><div class="ctitle">Proposals${hint}</div><div class="dimn">No proposals yet — candidates Bull weighs will surface here with confidence, setup and outcome.</div></div>`;
  const stCls=s=>/reject|skip/i.test(s)?'red':/fill|exec|accept|taken/i.test(s)?'green':'amber';
  const rows=recent.slice(0,8).map(x=>`<tr onclick="go('ticker/${x.symbol}')"><td>${x.ts||''}</td><td>${x.symbol||''}</td><td class="${x.side==='Buy'||x.side==='Long'?'up':'dn'}">${x.side||''}</td><td>${x.qty||''}</td><td>${x.setup?esc(x.setup):'—'}</td><td class="score">${x.confidence!=null?(typeof x.confidence==='number'&&x.confidence<=1?Math.round(x.confidence*100)+'%':x.confidence):'—'}</td><td><span class="pill2 ${stCls(x.status||x.outcome||'')}">${esc(x.status||x.outcome||'—')}</span></td></tr>`).join('');
  return `<div class="card"><div class="ctitle">Proposals${hint}</div><table><thead><tr><th>When</th><th>Sym</th><th>Side</th><th>Qty</th><th>Setup</th><th>Conf</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`;}

function pgPositions(){const d=DATA;const out=card('Positions','sortable · click a row for detail','<div id="ptbl"></div>');
  const exposure=card('Exposure & concentration','% of equity',(d.positions||[]).map(p=>`<div class="barrow"><span class="nm">${p.t}</span><div class="bartrack"><div class="barfill" style="width:${Math.min(100,(p.mktVal/d.equity*100)).toFixed(0)}%"></div></div><span style="width:46px;text-align:right">${(p.mktVal/d.equity*100).toFixed(0)}%</span></div>`).join('')+`<div class="dimn" style="margin-top:8px">Gross exposure ${(((d.risk||{}).grossExposure)||0)}% · largest single ${(((d.risk||{}).largestPos)||0)}% (cap ${((d.caps||{}).maxPosition||40)}%)</div>`);
  deferred.push(()=>{const el=$('#ptbl');if(el)el.appendChild(posTable(d.positions||[]));});
  return out+exposure;
}

function pgBlotter(){const d=DATA;
  const open=card('Open orders','working',(d.openOrders&&d.openOrders.length)?`<table><thead><tr><th>Time</th><th>Sym</th><th>Side</th><th>Type</th><th>Qty</th><th>Limit</th><th>Status</th></tr></thead><tbody>${d.openOrders.map(o=>`<tr onclick="go('ticker/${o.t}')"><td>${o.time}</td><td>${o.t}</td><td class="${o.side==='Buy'?'up':'dn'}">${o.side}</td><td>${o.type}</td><td>${o.qty}</td><td>${o.limit?'$'+o.limit:'mkt'}</td><td><span class="pill2 amber">${o.status}</span></td></tr>`).join('')}</tbody></table>`:'<div class="dimn">No working orders.</div>');
  const blot=card('Fills / blotter','executed','<div id="btbl"></div>');
  deferred.push(()=>{const el=$('#btbl');if(!el)return;const F=(d.fills||[]).map(x=>Object.assign({},x));if(!F.length){el.innerHTML='<div class="dimn">No fills yet — executed orders will appear here as Bull trades.</div>';return;}el.appendChild(tableSort(F,[{k:'time',h:'Time'},{k:'t',h:'Sym'},{k:'side',h:'Side'},{k:'qty',h:'Qty'},{k:'price',h:'Price'},{k:'value',h:'Value'}],f=>`<tr onclick="go('ticker/${f.t}')"><td>${f.time}</td><td>${f.t}</td><td class="${f.side==='Buy'?'up':'dn'}">${f.side}</td><td>${f.qty}</td><td>$${(+f.price).toFixed(2)}</td><td>${usd((f.qty*f.price)||f.value)}</td></tr>`,'time'));});
  return open+blot;
}

function pgJournal(){const J=DATA.journal||[];
  return card('Trade journal','every closed trade — grade + lesson',J.length?J.map(j=>`<div class="card" style="margin:0 0 12px;padding:14px 16px">
    <div class="tkhead" style="margin-bottom:6px"><div>${tk(j.t)} <span class="tag ${j.side==='Long'?'buy':'sell'}">${j.side}</span> <span class="dimn">${j.opened} → ${j.closed}</span></div>
    <div style="text-align:right"><span class="grade ${j.pnlPct>=0?'up':'dn'}">${j.grade}</span> <span class="${cls(j.pnlPct)}" style="font-family:var(--num);font-size:18px">${pc(j.pnlPct)}</span></div></div>
    <div class="dimn">Entry $${j.entry} · exit $${j.exit} · ${j.qty} sh · ${(j.pnlUsd>=0?'+':'')+usd(Math.abs(j.pnlUsd))}</div>
    <div class="note" style="margin-top:6px"><b>Lesson:</b> ${esc(j.lesson)}</div></div>`).join(''):'<div class="dimn">No closed trades yet.</div>');
}

function pgRisk(){const r=DATA.risk||{},c=DATA.caps||{};
  function meter(label,val,limit,inverse){const pctv=Math.min(100,Math.abs(val)/Math.abs(limit)*100);const danger=pctv>75;const col=danger?'var(--ruby)':pctv>50?'var(--amber)':'var(--emer)';
    return `<div class="dimn">${label}</div><div class="note"><b>${val}%</b> <span class="dim">of ${limit}% ${inverse?'halt':'cap'}</span></div><div class="meter"><div class="meterfill" style="width:${pctv}%;background:${col}"></div><div class="lim" style="left:100%"></div></div>`;}
  return `${alertsBanner(DATA.alerts)}
  ${readinessCard(DATA.readiness)}
  <div class="grid2">
    ${card('Daily loss halt','resets at the open',meter('Today P&L',DATA.dayPnlPct,-(c.dailyHalt||10),true)+`<div class="dimn">${DATA.dayPnlPct<=-(c.dailyHalt||10)?'<span class="dn">HALTED — no new entries today.</span>':'Within limit — trading active.'}</div>`)}
    ${card('Monthly kill-switch','flattens & stops',meter('Month P&L',DATA.monthPnlPct,-(c.monthlyKill||30),true)+`<div class="dimn">${DATA.monthPnlPct<=-(c.monthlyKill||30)?'<span class="dn">KILLED for the month.</span>':'Within limit.'}</div>`)}
  </div>
  <div class="grid2">
    ${card('Drawdown','from peak',`<div class="val ${cls(-(r.drawdown||0))}" style="font-family:var(--num);font-size:30px">${r.drawdown||0}%</div><div class="dimn">Max DD ${r.maxDD||0}% · peak equity ${usd(r.peakEquity||DATA.equity)}</div>`)}
    ${card('Exposure','live',`<div class="dimn">Gross exposure</div><div class="note"><b>${r.grossExposure||0}%</b></div><div class="dimn" style="margin-top:6px">Largest single <b>${r.largestPos||0}%</b> (cap ${c.maxPosition||40}%) · sector <b>${r.sectorConc||0}%</b> (cap ${c.sectorCap||80}%)</div>`)}
  </div>
  ${card('Active guardrails','aggressive paper profile','<ul class="rules">'+
     `<li>Risk per trade: <b>${c.riskPerTrade||10}%</b> of equity</li>`+
     `<li>Max single position: <b>${c.maxPosition||40}%</b></li>`+
     `<li>Max sector: <b>${c.sectorCap||80}%</b></li>`+
     `<li>Trailing stop: <b>~${c.trailingStop||18}%</b></li>`+
     `<li>Daily loss halt: <b>${c.dailyHalt||10}%</b> · Monthly kill: <b>${c.monthlyKill||30}%</b></li>`+
     `<li>LIVE profile: <b class="dn">LOCKED</b> — paper only until CJ's written opt-in</li>`+
     '</ul>')}`;
}

function pgStrategy(){const st=DATA.strategy||{};
  return `${card(st.name||'Strategy','active profile',`<div class="note">${st.desc||''}</div>`)}
  ${card('Signal rules','what triggers a trade','<ul class="rules">'+(st.rules||[]).map(r=>`<li>${esc(r)}</li>`).join('')+'</ul>')}
  ${card('Today\'s signal queue','candidates the bot is weighing',(DATA.signals&&DATA.signals.length)?`<table><thead><tr><th>Sym</th><th>Signal</th><th>Score</th><th>Action</th></tr></thead><tbody>${DATA.signals.map(s=>`<tr onclick="go('ticker/${s.t}')"><td>${s.t}</td><td>${s.signal}</td><td class="score">${s.score}</td><td><span class="pill2 ${s.action==='Buy'?'green':s.action==='Sell'?'red':'amber'}">${s.action}</span></td></tr>`).join('')}</tbody></table>`:'<div class="dimn">Queue empty — no signals firing right now.</div>')}
  ${proposalsCard(DATA.proposals)}`;
}

function pgMovers(){const m=DATA.movers||{};
  const mk=a=>(a||[]).map(x=>`<tr onclick="go('ticker/${x.t}')"><td>${x.t}</td><td>$${x.price}</td><td class="${cls(x.chg)}">${pc(x.chg)}</td><td class="dim">${x.vol||''}</td></tr>`).join('');
  return `<div class="grid3">
    ${card('Gainers','today',`<table><tbody>${mk(m.gainers)}</tbody></table>`)}
    ${card('Losers','today',`<table><tbody>${mk(m.losers)}</tbody></table>`)}
    ${card('Most active','volume',`<table><tbody>${mk(m.active)}</tbody></table>`)}
  </div>`;
}

/* ============ TICKER DETAIL ============ */
function renderTicker(t){const d=DATA;const p=(d.positions||[]).find(x=>x.t===t)||{};const j=(d.journal||[]).filter(x=>x.t===t);const T=(d.tickers||{})[t]||{};
  $('#main').innerHTML=`<div class="back" onclick="history.length>1?history.back():go('positions')">← Back</div>
  <div class="tkhead"><div><div class="title" style="cursor:default">${t}</div><div class="subtitle">${T.name||p.name||''} ${T.sector?'· '+T.sector:''}</div></div>
    <div style="text-align:right"><div class="tkprice">$${(+(p.price||T.last||0)).toFixed(2)}</div><div class="${cls(p.dayPct||T.chgPct||0)}">${pc(p.dayPct||T.chgPct||0)} today · <span id="rangelbl" class="dimn"></span></div></div></div>
  ${card('Price','<span class="lnk" onclick="window.open(\'https://www.tradingview.com/symbols/'+t+'/\',\'_blank\')">TradingView ↗</span>','<div id="tch"></div>')}
  ${p.qty?card('Your position','paper',`<div class="tkmeta"><div class="b">Qty<b>${p.qty}</b></div><div class="b">Value<b>${usd(p.mktVal)}</b></div><div class="b">Avg cost<b>$${p.avg||'—'}</b></div><div class="b">Unreal<b class="${cls(p.unrealPct)}">${pc(p.unrealPct)}</b></div><div class="b">Stop<b>$${p.stop||'—'}</b></div></div>`):''}
  ${T.thesis?card('Bot thesis','why it\'s in the book',`<div class="note">${esc(T.thesis)}</div>`):''}
  ${j.length?card('Trade history','closed trades on this name',j.map(x=>`<div class="dimn" style="padding:7px 0;border-bottom:1px solid var(--line)"><b class="${cls(x.pnlPct)}">${pc(x.pnlPct)}</b> · ${x.opened}→${x.closed} · grade ${x.grade} — ${esc(x.lesson)}</div>`).join('')):''}`;
  deferred=[];const el=$('#tch');if(el)renderChart(el,t,(T.spark||p.spark||[]));
}

/* ============ SITE SWITCHER (data-driven) + REFRESH ============ */
/* Cross-hub nav. To add a project: add ONE entry to SITES below (and mirror it in the other hubs).
   id  — unique key; the entry whose id === SITE_ID is the current hub (no link, routes home).
   name/tag — label + sub-label.  url — hub URL.  mark/color — brand glyph + accent. */
const SITE_ID='bull';
const SITES=[
  {id:'go',name:'Go',tag:'Advisor & research',url:'https://go.dimsylaisolutions.com', mark:'✦',color:'#7c89c0'},
  {id:'bull', name:'Bull', tag:'Trading console',    url:'https://bull.dimsylaisolutions.com',mark:'◆',color:'#b8932f'},
  // {id:'NEW',name:'…',tag:'…',url:'https://….dimsylaisolutions.com',mark:'★',color:'#5a8'},
];
function buildSwitcher(){const m=$('#switchmenu');if(!m)return;
  m.innerHTML=SITES.map(s=>{const cur=s.id===SITE_ID;
    return `<a class="${cur?'active':''}" ${cur?`onclick="go('overview');toggleSwitch(false)"`:`href="${s.url}" target="_blank" rel="noopener"`}><span class="sm-mark" style="color:${s.color}">${s.mark}</span><div><b>${esc(s.name)}</b><div class="dim small">${esc(s.tag)}${cur?'':' ↗'}</div></div></a>`;
  }).join('');}
function toggleSwitch(f){$('#switchmenu').classList.toggle('open',f);}
$('#brandbtn').onclick=e=>{e.stopPropagation();$('#switchmenu').classList.toggle('open');};
document.addEventListener('click',()=>$('#switchmenu').classList.remove('open'));

/* ============ IN-SITE EMBED OVERLAY — external links open here, staying on Bull ============ */
function openEmbed(url,title){const m=$('#embedModal');if(!m)return;
  m.innerHTML=`<div class="embedBack"></div><div class="embedWin"><div class="embedBar"><span class="embedTitle">${esc(title||'Preview')}</span><span class="embedUrl">${esc(url.replace(/^https?:\/\//,'').slice(0,42))}</span><a class="embedExt" href="${esc(url)}" target="_blank" rel="noopener">Open externally ↗</a><span class="embedX" title="Close (Esc)">✕</span></div><iframe class="embedFrame" src="${esc(url)}" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups allow-forms"></iframe><div class="embedNote">Stays blank? That site blocks embedding — use “Open externally ↗”.</div></div>`;
  m.classList.add('open');m.setAttribute('aria-hidden','false');m.querySelector('.embedBack').onclick=closeEmbed;m.querySelector('.embedX').onclick=closeEmbed;openModalA11y(m.querySelector('.embedWin'),(title||'Preview')+' — preview');}
function closeEmbed(){const m=$('#embedModal');if(m){const w=m.querySelector('.embedWin');m.classList.remove('open');m.setAttribute('aria-hidden','true');m.innerHTML='';closeModalA11y(w);}}
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeEmbed();});
document.addEventListener('click',e=>{if(e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;/* let modified/middle clicks open a real new tab */const a=e.target.closest('a[target="_blank"]');if(!a)return;if(a.classList.contains('embedExt')||a.closest('#switchmenu'))return;const href=a.getAttribute('href')||'';if(!/^https?:\/\//.test(href))return;e.preventDefault();openEmbed(a.href,(a.textContent||'').trim().slice(0,80));});
let lastFetch=null;
async function pull(){const b=$('#reload');if(b)b.classList.add('spin');try{const r=await fetch('data/status.json?_='+Date.now());DATA=await r.json();lastFetch=new Date();}catch(e){}finally{if(b)b.classList.remove('spin');}}
function chrome(){const d=DATA;$('#botstate').textContent=((d.bot||{}).status||'—').toUpperCase();$('#profile').textContent=(d.profile||'Aggressive').split('·')[0].trim();$('#regime').textContent='Regime: '+(d.regime||'—');$('#sampleBadge').innerHTML=d.isSample?'<span style="color:var(--amber)">sample data</span>':(d.updated||'');const u=$('#updlbl');if(u)u.textContent='pulled '+(lastFetch?lastFetch.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):'—');}
$('#reload').onclick=async()=>{await pull();chrome();route();};

/* ============ BOOT ============ */
async function boot(){buildSwitcher();await pull();chrome();route();}
/* Page re-pulls status.json every 5 min (free). Only the Bull agent routine that REGENERATES it costs credits. */
setInterval(async()=>{await pull();chrome();
  /* don't rebuild main while the user is mid-interaction (slider, modal) */
  const ae=document.activeElement,editing=ae&&ae.matches&&ae.matches('#main input,#main select,#main textarea'),modalOpen=!!document.querySelector('.embedModal.open');
  if(editing||modalOpen)return;
  const v=document.body.dataset.page||'overview';if(v!=='ticker')route();},300000);
boot();
