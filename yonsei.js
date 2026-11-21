/* tES Yonsei app v1 (2026-11-21). Pairs with firmware/tES_Yonsei_v1 (FW ID "tES-YONSEI v1 B<n>").
   Tabs: 점검 (LED / output waveform / PBS / battery) and 실험 (current sweep, phase sweep, manual).
   Add ?demo to the URL to try it without a board (simulated board, no Bluetooth). */
'use strict';

const SVC = '19b10100-e8f2-537e-4f6c-d104768a1214';
const CMD = '19b10101-e8f2-537e-4f6c-d104768a1214';
const STA = '19b10102-e8f2-537e-4f6c-d104768a1214';
const FW  = '19b10103-e8f2-537e-4f6c-d104768a1214';
const R_SENSE = 220, V_LIMIT = 33, BAT_LOW = 3.5, STALE_MS = 2000;
const DEMO = new URLSearchParams(location.search).has('demo');

const MENU = [
  {id:'led', n:1, t:'LED Test'},
  {id:'scope', n:2, t:'Output Waveform Test'},
  {id:'pbs', n:3, t:'PBS Test'},
  {id:'safe', n:4, t:'Battery Test'}
];
const SWEEP = {C:{steps:[0.5,1.0,1.5,2.0,2.5,3.0].map(i=>({I:i,pw:500}))}, P:{steps:[100,200,300,400,500].map(w=>({I:3.0,pw:w}))}};
const E = {sweep:'C', step:0, done:{C:[],P:[]}, mcount:0, rat:null, el:null, edit:null};
const S = {screen:'menu', mode:'1 session', I:3.0, pw:500, R:10, logOpen:null, confirm:false};
const BAT_RUNS = 50;
const $ = id => document.getElementById(id);

/* ---------------- board link ---------------- */
const B = {
  connected:false, name:'', board:'', fw:'', lastMs:0,
  st:'0', burst:0, pulse:0, pct:null, bat:null, reason:'P',
};
let run = null;        // {kind, screen, id, cond, bursts, sessions, done, batStart}
let gatt = null, cmdChar = null, writeQ = Promise.resolve(), wakeLock = null, sim = null;

async function connect(){
  if(DEMO){ sim = new SimBoard(onStatusText); B.connected=true; B.fw='tES-YONSEI v1 B0 (demo)'; B.board='demo'; B.lastMs=Date.now(); render(); return; }
  if(!navigator.bluetooth){ toast('이 브라우저는 Bluetooth를 지원하지 않아요. Android Chrome에서 여세요.'); return; }
  try{
    const dev = await navigator.bluetooth.requestDevice({filters:[{services:[SVC]}]});
    dev.addEventListener('gattserverdisconnected', onDisconnected);
    gatt = await dev.gatt.connect();
    const svc = await gatt.getPrimaryService(SVC);
    cmdChar = await svc.getCharacteristic(CMD);
    try{ B.fw = new TextDecoder().decode(await (await svc.getCharacteristic(FW)).readValue()); }catch(e){ B.fw='?'; }
    const m = /B(\d+)/.exec(B.fw); B.board = m ? m[1] : '?';
    const sta = await svc.getCharacteristic(STA);
    sta.addEventListener('characteristicvaluechanged', ev => onStatusText(new TextDecoder().decode(ev.target.value)));
    await sta.startNotifications();
    B.connected = true; B.lastMs = Date.now();
    keepAwake();
    send('?');
    render();
  }catch(e){ if(e && e.name!=='NotFoundError') toast('연결 실패: '+(e.message||e)); }
}
function onDisconnected(){
  B.connected = false; cmdChar = null;
  if(run) finishRun('D');
  render();
}
function send(text){
  if(sim){ sim.write(text); return Promise.resolve(); }
  if(!cmdChar) return Promise.reject(new Error('not connected'));
  const p = writeQ.then(() => cmdChar.writeValueWithResponse(new TextEncoder().encode(text)));
  writeQ = p.catch(()=>{});
  return p;
}
async function keepAwake(){ try{ if('wakeLock' in navigator && !wakeLock){ wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release',()=>{wakeLock=null;}); } }catch(e){} }
document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='visible' && B.connected) keepAwake(); });

function onStatusText(t){
  const [st, burst, pulse, pct, bat, reason] = t.trim().split(',');
  const prev = B.st;
  B.st = st; B.burst = +burst||0; B.pulse = +pulse||0;
  B.pct = (pct===undefined||pct==='-') ? null : +pct;
  if(+bat>0) B.bat = +bat/100;
  B.reason = reason||'-';
  B.lastMs = Date.now();
  if(run){
    if(st!=='0') run.started = true;
    if(st==='0' && !run.started && reason==='E'){ finishRun('E'); render(); return; }
    if(st==='0' && run.started && prev!=='0'){
      if(run.kind==='bat' && reason==='F' && run.done+1 < run.sessions){ run.done++; run.started=false; run.worst=worse(run.worst,B.pct); setTimeout(()=>{ if(run) send(run.cmd); }, 1000); }
      else finishRun(reason);
    }
  }
  render();
}
setInterval(()=>{ if(B.connected) renderStatus(); }, 500);

/* ---------------- real-current grade ---------------- */
function grade(p){ return p==null?'na': p<20?'none': (p<80||p>120)?'low':'ok'; }
const LAMP = {ok:'#16a34a', low:'#eab308', none:'#dc2626', na:'#c9d1d3'};
const GTXT = {ok:'정상', low:'범위 밖', none:'출력 없음', na:'측정 안 함'};
function worse(a,b){ if(a==null) return b; if(b==null) return a; return Math.abs(b-100)>Math.abs(a-100)?b:a; }

/* ---------------- logs ---------------- */
const LOG_KEY = 'tes-yonsei-log-v1';
let LOG = {chk:{view:[],all:[]}, exp:{view:[],all:[]}};
try{ const v=JSON.parse(localStorage.getItem(LOG_KEY)||'null'); if(v&&v.chk&&v.exp) LOG=v; }catch(e){}
function saveLog(){ try{ localStorage.setItem(LOG_KEY, JSON.stringify(LOG)); }catch(e){} }
function nowT(){ const d=new Date(); return [d.getHours(),d.getMinutes(),d.getSeconds()].map(x=>String(x).padStart(2,'0')).join(':'); }
function addLog(k, r){ r.t=nowT(); r.d=new Date().toISOString(); r.board=B.board; LOG[k].view.push(r); LOG[k].all.push(r); saveLog(); }

/* ---------------- runs ---------------- */
function startRun(){
  if(run || !B.connected) return;
  const i10 = Math.round(S.I*10);
  let cmd, kind='out', bursts=5, sessions=1;
  if(S.screen==='led'){ cmd=`L30,500`; kind='led'; bursts=0; }
  else if(S.screen==='scope'){
    if(S.mode==='HOLD +') { cmd=`H+${i10}`; kind='hold'; bursts=0; }
    else if(S.mode==='HOLD −') { cmd=`H-${i10}`; kind='hold'; bursts=0; }
    else { bursts = S.mode==='1 burst'?1:5; cmd=`B${i10},${S.pw},${bursts}`; }
  }
  else if(S.screen==='pbs'){ cmd=`B${i10},${S.pw},5`; }
  else if(S.screen==='safe'){ cmd=`B30,500,5`; kind='bat'; sessions=BAT_RUNS; }
  else if(S.screen==='exp'){ cmd=`B${i10},${S.pw},5`; }
  run = {kind, screen:S.screen, cmd, bursts, sessions, done:0, started:false, worst:null,
         id: S.screen==='exp' ? expId() : {led:'LED',scope:'WAVE',pbs:'PBS',safe:'BAT'}[S.screen],
         cond: cond(), batStart:B.bat, I:S.I, pw:S.pw, sweep:E.sweep, step:E.step};
  send(cmd).catch(e=>{ toast('명령을 보내지 못했어요'); run=null; render(); });
  const mine = run;
  setTimeout(()=>{ if(run===mine && !run.started){ finishRun('E'); toast('보드가 시작하지 않았어요'); render(); } }, 5000);
  render();
}
function stopNow(){ send('S').catch(()=>{}); }
function finishRun(reason){
  const r = run; run = null;
  if(!r) return;
  const worst = worse(r.worst, B.pct);
  const completed = reason==='F' || (r.kind==='led' && reason==='U') || (r.kind==='hold' && (reason==='U'||reason==='T'));
  const entry = {id:r.id, cond:r.cond, pct:worst};
  if(completed) entry.res = grade(worst);
  else entry.res = 'stp', entry.why = reason, entry.b = r.bursts===5 ? B.burst : null;
  if(r.kind==='bat'){ entry.cond = `${r.done+(reason==='F'?1:0)}/${r.sessions} · ${fmtV(r.batStart)}→${fmtV(B.bat)}`; }
  addLog(r.screen==='exp'?'exp':'chk', entry);
  if(r.screen==='exp'){
    if(r.sweep==='M') E.mcount++;
    else if(completed && !E.done[r.sweep].includes(r.step)) E.done[r.sweep].push(r.step);
  }
}
const fmtV = v => v==null ? '?' : v.toFixed(2)+' V';
function cond(){
  if(S.screen==='led') return '3.0 mA · ± 교대';
  if(S.screen==='safe') return `1 session × ${BAT_RUNS}`;
  if(S.screen==='scope' && S.mode.startsWith('HOLD')) return `${S.mode} ${S.I.toFixed(1)} mA`;
  const base = `${S.I.toFixed(1)} mA · ${S.pw} µs`;
  if(S.screen==='scope') return base + ` · ${S.R}k${S.mode==='1 burst'?' · 1b':''}`;
  return base;
}

/* ---------------- views ---------------- */
function chips(label, key, values, fmt=v=>v, dis=()=>false){
  return `<div><div class="lbl">${label}</div><div class="chips">${values.map(v=>
    `<button type="button" class="chip${S[key]===v?' on':''}" data-k="${key}" data-v="${v}" ${run||dis(v)?'disabled':''}>${fmt(v)}</button>`).join('')}</div></div>`;
}
function wave(){
  const I=S.I, pw=S.pw, hold=S.screen==='scope' && S.mode.startsWith('HOLD');
  const h=Math.max(10, 38*I/3), x0=30, w=Math.min(120, Math.max(12, 110*pw/500));
  let pts, txt;
  if(hold){
    const plus = S.mode==='HOLD +', y = plus ? 60-h : 60+h;
    pts=`10,60 ${x0},60 ${x0},${y} 270,${y} 270,60 290,60`;
    txt=`<text x="40" y="${plus?y-4:y+14}">${plus?'+':'−'}${I.toFixed(1)} mA DC (최대 30 s)</text>`;
  } else {
    pts=`10,60 ${x0},60 ${x0},${60+h} ${x0+w},${60+h} ${x0+w},${60-h} ${x0+2*w},${60-h} ${x0+2*w},60 290,60`;
    txt=`<text x="${x0+4}" y="${60+h+13}">−${I.toFixed(1)} mA · ${pw} µs</text><text x="${x0+w+4}" y="${60-h-4}">+${I.toFixed(1)} mA</text><text x="210" y="114">주기 3.0 ms</text>`;
  }
  const Q=(I*pw/1000).toFixed(2);
  const session = S.screen!=='scope' || S.mode==='1 session';
  const info = hold ? `<span>전류 <b>${I.toFixed(1)} mA</b></span><span>V<sub>sense</sub> <b>${(I*R_SENSE/1000).toFixed(2)} V</b></span>`
    : `<span><b>333 Hz</b></span><span>${session?'200 pulse × 5 burst, 간격 3 s':'200 pulse'}</span><span>Q <b>${Q} µC</b></span>`;
  return `<div class="scope"><svg viewBox="0 0 300 120" role="img" aria-label="설정한 파형"><line x1="0" y1="60" x2="300" y2="60" stroke="var(--grid)" stroke-dasharray="3 3"/><polyline points="${pts}" fill="none" stroke="var(--wave)" stroke-width="2"/>${txt}</svg><div class="readout">${info}</div></div>`;
}
function measTag(){
  if(B.pct==null) return '';
  const g=grade(B.pct);
  return `<span class="meas"><i style="background:${LAMP[g]}"></i>실제 전류 ${GTXT[g]}${g==='ok'?'':' · '+B.pct+' %'}</span>`;
}
function progress(){
  if(!run) return '';
  const st = B.st;
  if(st==='W' || !run.started) return `<div class="prog"><div class="lbl">준비 중…</div></div>`;
  if(run.kind==='led') return `<div class="prog"><div class="lbl">깜빡이는 중 · ${B.burst===1?'− 방향':'+ 방향'} · STOP을 누를 때까지</div>${measTag()}</div>`;
  if(run.kind==='hold') return `<div class="prog"><div class="lbl">HOLD 중 · 최대 30 s</div>${measTag()}</div>`;
  const head = run.kind==='bat' ? `session ${run.done+1}/${run.sessions} · ` : '';
  if(run.bursts===1) return `<div class="prog"><div class="lbl">${head}출력 중 · pulse ${B.pulse}/200</div>${measTag()}</div>`;
  const frac = st==='G' ? 100 : B.pulse/2;
  const lbl = st==='G' ? `burst ${B.burst}/5 끝 · 다음 burst까지 3 s` : `burst ${B.burst}/5 · pulse ${B.pulse}/200`;
  return `<div class="prog"><div class="lbl">${head}${lbl}</div><div class="bursts">${[1,2,3,4,5].map(b=>`<i class="${b<B.burst?'done':''}" style="${b===B.burst?`background:linear-gradient(90deg,var(--wave) ${frac}%,var(--grid) ${frac}%)`:''}"></i>`).join('')}</div>${measTag()}</div>`;
}
function runBtn(label){ return `<button type="button" class="btn" id="run" ${run||!B.connected?'disabled':''}>${run?'출력 중…':label}</button>`; }

function resTxt(r){
  if(r.res==='stp'){ const w={D:'끊김',T:'시간 초과',E:'오류'}[r.why]; return `<span class="stp">${w||'STOP'}${!w&&r.b?' '+r.b+'/5':''}</span>`; }
  return `<span class="lamp" title="${GTXT[r.res]} ${r.pct??''}%" style="background:${LAMP[r.res]}"></span>`;
}
function rowHTML(r, full, n){
  if(r.sep) return `<span class="sep">${r.sep}</span>`;
  return `<div>${full?`<span class="t">${n}</span>`:''}<span class="t">${full?r.t:r.t.slice(0,5)}</span><span>${r.id}</span><span>${r.cond}</span>${resTxt(r)}</div>`;
}
function logBlock(k){
  const v=LOG[k].view, runs=v.filter(r=>!r.sep).length;
  return `<div><div class="loghead"><span class="lbl">Log</span><span class="acts">${runs?`<button type="button" data-logopen="${k}">전체 ${runs}회 ›</button>`:''}</span></div>`+
    `<div class="log prev" data-logopen="${k}">${v.length?v.slice(-3).reverse().map(r=>rowHTML(r,false)).join(''):'<span class="muted">없음</span>'}</div></div>`;
}
function logFull(m,k){
  const v=LOG[k].view; let n=v.filter(r=>!r.sep).length;
  const name = k==='exp'?'실험':'점검';
  m.innerHTML = `<button type="button" class="back" data-logclose>‹ ${name}</button>`+
    `<div class="loghead"><h2>${name} Log · ${n}회</h2>${v.length?`<span class="acts"><button type="button" data-reset="${k}">Reset</button></span>`:''}</div>`+
    `<div class="log full">${v.length?v.slice().reverse().map(r=>rowHTML(r,true,r.sep?'':n--)).join(''):'<span class="muted">없음</span>'}</div>` + progress() +
    (S.confirm?`<div class="modal"><div class="box"><b>${name} Log를 지울까요?</b><div class="row2"><button type="button" class="btn ghost" data-resetno>취소</button><button type="button" class="btn" style="background:var(--stop)" data-resetyes="${k}">Reset</button></div></div></div>`:'');
}

function renderStatus(){
  const fresh = B.connected && Date.now()-B.lastMs < STALE_MS;
  const el = $('status');
  if(!B.connected){
    el.innerHTML = `<span class="dot" style="background:var(--stop)"></span><span>연결 안 됨</span><button type="button" class="connect" id="connect">연결</button>`;
    return;
  }
  const bat = B.bat==null ? '배터리 –' : `배터리 ${B.bat.toFixed(2)} V`;
  const stTxt = run ? '출력 중' : '대기';
  el.innerHTML = `<span class="dot" style="background:${fresh?'var(--ok)':'var(--stop)'}"></span><span>${fresh?'연결됨':'응답 없음'}</span>`+
    `<span class="muted">보드 #${B.board}</span><span class="mono" style="color:${B.bat!=null&&B.bat<BAT_LOW?'var(--warn)':'var(--muted)'}">${bat}</span>`+
    `<span class="state${run?' run':''}">${stTxt}</span>`;
}

function render(){
  renderStatus();
  const m = $('main');
  $('tabC').className = S.screen==='exp' ? '' : 'on'; $('tabE').className = S.screen==='exp' ? 'on' : '';
  if(S.logOpen){ logFull(m, S.logOpen); return; }
  if(S.screen==='exp'){ renderExp(m); return; }
  if(S.screen==='menu'){
    m.innerHTML = `<div class="menu">${MENU.map(x=>
      `<button type="button" class="item" data-go="${x.id}"><span class="num">${x.n}</span><span><b>${x.t}</b></span><span class="arrow">›</span></button>`).join('')}</div>` + logBlock('chk');
    return;
  }
  const head = t => `<button type="button" class="back" data-go="menu">‹ 점검 메뉴</button><h2>${t}</h2>`;
  if(S.screen==='led'){
    const on = run && run.kind==='led' && run.started;
    const lit = p => on && ((p==='−')===(B.burst===1));
    m.innerHTML = head('1 · LED Test') +
      `<div class="scope" style="display:flex;justify-content:center;gap:40px;padding:20px">${['+','−'].map(p=>`<div style="text-align:center"><div style="width:40px;height:40px;border-radius:50%;margin:0 auto 4px;background:${lit(p)?'#ef4444':'var(--grid)'};box-shadow:${lit(p)?'0 0 14px #ef4444':'none'}"></div><small class="muted">LED ${p}</small></div>`).join('')}</div>` +
      `<div class="readout"><span>고정: <b>3.0 mA</b> · 500 µs pulse · 333 Hz</span><span>− 방향 0.5 s → + 방향 0.5 s 번갈아 반복</span></div>` +
      progress() + runBtn('깜빡이기 시작') + logBlock('chk');
  } else if(S.screen==='scope'){
    const V=(S.I*S.R).toFixed(1);
    m.innerHTML = head('2 · Output Waveform Test') +
      chips('출력 방식','mode',['HOLD +','HOLD −','1 burst','1 session']) +
      chips('전류 (mA)','I',[0.5,1.0,1.5,2.0,2.5,3.0],v=>v.toFixed(1)) +
      chips('Phase (µs)','pw',[100,200,300,400,500,700],v=>v,()=>S.mode.startsWith('HOLD')) +
      chips('부하 저항 (kΩ)','R',[1,5,10,15]) +
      wave() + `<div class="readout"><span>scope 예상: 저항 양단 <b>±${V} V</b></span>${S.I*S.R>V_LIMIT?'<span style="color:var(--warn)">전압 한계(≈33 V) 넘음</span>':''}</div>` +
      progress() + runBtn(S.mode.startsWith('HOLD')?'HOLD 시작 (30 s)':'출력') + logBlock('chk');
  } else if(S.screen==='pbs'){
    m.innerHTML = head('3 · PBS Test') +
      chips('전류 (mA)','I',[0.5,1.0,1.5,2.0,2.5,3.0],v=>v.toFixed(1)) +
      chips('Phase (µs)','pw',[100,200,300,400,500,700]) +
      wave() + progress() + runBtn('1 session 출력') + logBlock('chk');
  } else if(S.screen==='safe'){
    m.innerHTML = head('4 · Battery Test') +
      `<div class="readout"><span>지금 배터리 <b>${fmtV(B.bat)}</b></span><span>3.0 mA · 500 µs · 1 session × ${BAT_RUNS}</span></div>` +
      progress() + runBtn(`하루치 반복 시작 (1 session × ${BAT_RUNS})`) + logBlock('chk');
  }
}

function expId(){ return E.sweep==='M' ? 'M'+(E.mcount+1) : E.sweep+(E.step+1); }
function elTxt(){ return E.el ? (E.el.type==='F'?'Flat ':'Porous ')+E.el.n : '—'; }
function renderExp(m){
  const dis = run ? 'disabled' : '';
  let who = `<div class="who"><button type="button" data-edit="rat" ${dis}><span>Rat</span><b>${E.rat??'—'}</b></button><button type="button" data-edit="el" ${dis}><span>전극</span><b>${elTxt()}</b></button></div>`;
  if(E.edit){
    const isEl=E.edit.k==='el';
    who = `<div class="edit"><div class="lbl" style="margin:0">${isEl?'전극':'Rat'} 번호</div>`+
      (isEl?`<div class="seg" style="grid-template-columns:1fr 1fr">${[['F','Flat'],['P','Porous']].map(([k,t])=>`<button type="button" data-eltype="${k}" class="${E.edit.type===k?'on':''}">${t}</button>`).join('')}</div>`:'')+
      `<input id="numin" type="number" inputmode="numeric" min="1" value="${E.edit.n??''}" aria-label="번호">`+
      `<div class="row2"><button type="button" class="btn ghost" data-editcancel>취소</button><button type="button" class="btn" data-editok>확인</button></div></div>`;
  }
  const seg = `<div class="seg">${[['C','Current'],['P','Phase'],['M','Manual']].map(([k,t])=>`<button type="button" data-sw="${k}" class="${E.sweep===k?'on':''}" ${dis}>${t}</button>`).join('')}</div>`;
  let body;
  if(E.sweep==='M'){
    body = chips('전류 (mA)','I',[0.5,1.0,1.5,2.0,2.5,3.0],v=>v.toFixed(1)) + chips('Phase (µs)','pw',[100,200,300,400,500,700]);
  } else {
    const sw=SWEEP[E.sweep], st=sw.steps[E.step];
    if(!run){ S.I=st.I; S.pw=st.pw; }
    body = `<div class="steps" style="grid-template-columns:repeat(${sw.steps.length},1fr)">${sw.steps.map((x,i)=>
      `<button type="button" class="step${i===E.step?' cur':''}${E.done[E.sweep].includes(i)?' done':''}" data-st="${i}" ${dis}>${E.sweep}${i+1}<small>${E.sweep==='C'?x.I.toFixed(1):x.pw}</small></button>`).join('')}</div>`;
  }
  const id = run ? run.id : expId();
  const card = `<div class="now"><span class="id">${id}</span><span class="cond">${S.I.toFixed(1)} mA · ${S.pw} µs<small>333 Hz · 200 pulse × 5 burst</small></span></div>`;
  const focus = document.activeElement && document.activeElement.id==='numin';
  m.innerHTML = who + seg + card + body + wave() + progress() +
    `<button type="button" class="btn big" id="run" ${run||!B.connected?'disabled':''}>${run?id+' 출력 중…':id+' 시작'}</button>` + logBlock('exp');
  if(E.edit && !focus){ const i=$('numin'); if(i) i.focus(); }
}

function setWho(k, val){
  if(k==='rat') E.rat=val; else E.el=val;
  const sep=`Rat ${E.rat??'—'} · ${elTxt()}`;
  const v=LOG.exp.view; if(v.length && v[v.length-1].sep) v.pop();
  v.push({sep}); LOG.exp.all.push({sep, t:nowT(), d:new Date().toISOString()}); saveLog();
}
let toastTimer=null;
function toast(msg){ const t=$('toast'); t.textContent=msg; t.hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>{t.hidden=true;},4000); }

document.addEventListener('click', e=>{
  const T=s=>e.target.closest(s);
  if(T('#connect')){ connect(); return; }
  if(T('[data-logclose]')){ S.logOpen=null; S.confirm=false; render(); return; }
  if(T('[data-reset]')){ S.confirm=true; render(); return; }
  if(T('[data-resetno]')){ S.confirm=false; render(); return; }
  if(T('[data-resetyes]')){ S.confirm=false; const k=T('[data-resetyes]').dataset.resetyes; LOG[k].view=[]; LOG[k].all.push({sep:'(Reset)', t:nowT(), d:new Date().toISOString()}); saveLog(); render(); return; }
  if(T('[data-logopen]')){ const k=T('[data-logopen]').dataset.logopen; if(LOG[k].view.length){ S.logOpen=k; render(); } return; }
  const go=T('[data-go]'); if(go){ if(run) return; S.logOpen=null; S.screen=go.dataset.go; if(S.screen==='led'){S.I=3.0; S.pw=500;} render(); return; }
  const c=T('.chip'); if(c && !c.disabled){ const k=c.dataset.k, v=c.dataset.v; S[k]=isNaN(+v)?v:+v; render(); return; }
  const ed=T('[data-edit]'); if(ed && !ed.disabled){ const k=ed.dataset.edit; E.edit={k, n:k==='rat'?E.rat:E.el?.n, type:E.el?.type||'P'}; render(); return; }
  const et=T('[data-eltype]'); if(et){ E.edit.n=$('numin').value||null; E.edit.type=et.dataset.eltype; render(); return; }
  if(T('[data-editcancel]')){ E.edit=null; render(); return; }
  if(T('[data-editok]')){ const n=parseInt($('numin').value,10); if(n>0){ setWho(E.edit.k, E.edit.k==='rat'?n:{type:E.edit.type,n}); } E.edit=null; render(); return; }
  const sw=T('[data-sw]'); if(sw && !sw.disabled){ E.sweep=sw.dataset.sw; render(); return; }
  const st=T('[data-st]'); if(st && !st.disabled){ E.step=+st.dataset.st; render(); return; }
  if(T('#run')) startRun();
});
document.addEventListener('keydown', e=>{ if(e.key==='Enter' && e.target.id==='numin') document.querySelector('[data-editok]').click(); });
$('stop').addEventListener('click', stopNow);

/* ---------------- demo board (?demo) ---------------- */
class SimBoard {
  constructor(cb){ this.cb=cb; this.st='0'; this.burst=0; this.pulse=0; this.pct=null; this.bat=395; this.reason='P'; this.tick=setInterval(()=>this.step(),200); this.emit(); }
  emit(){ this.cb(`${this.st},${this.burst},${this.pulse},${this.pct??'-'},${this.bat},${this.st==='0'?this.reason:'-'}`); }
  write(t){
    const c=t[0];
    if(c==='?'){ this.emit(); return; }
    if(c==='S'||c==='0'){ this.stop('U'); return; }
    if(this.st!=='0'){ this.stop('E'); return; }
    this.pct=null; this.burst=0; this.pulse=0; this.t=0;
    if(c==='B'){ const [i,pw,n]=t.slice(1).split(',').map(Number); this.n=n; this.mode='B'; }
    else if(c==='H'){ this.mode='H'; }
    else if(c==='L'){ this.mode='L'; }
    else { this.stop('E'); return; }
    this.st='W'; this.emit();
  }
  stop(r){ this.st='0'; this.reason=r; this.pulse=0; this.emit(); }
  step(){
    this.t+=200;
    if(this.st==='0'){ if(this.t%1000<200) this.emit(); return; }
    if(this.st==='W' && this.t>=1000){ this.t=0; this.burst=1; this.st = this.mode==='B'?'B':this.mode==='H'?'H':'L'; }
    else if(this.st==='B'){ this.pulse=Math.min(200,this.pulse+67); this.pct=98; if(this.pulse>=200){ this.bat=Math.max(330,this.bat-1); if(this.burst>=this.n){ this.stop('F'); return; } this.st='G'; this.t=0; } }
    else if(this.st==='G' && this.t>=3000){ this.st='B'; this.burst++; this.pulse=0; }
    else if(this.st==='L'){ this.pct=99; if(this.t%600<200) this.burst=this.burst===1?2:1; if(this.t>=120000){ this.stop('T'); return; } }
    else if(this.st==='H'){ this.pct=100; if(this.t>=30000){ this.stop('T'); return; } }
    this.emit();
  }
}

if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
render();
