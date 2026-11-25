/* tES Yonsei app v2 (2026-11-24). Pairs with firmware/tES_Yonsei_v2 (FW ID "tES-YONSEI v2 B<n>").
   Waveform: 500+500 us biphasic, 200 us rest, period 1.2 ms; 200 pulses x 5 bursts; burst gap 1/3/5/7/9 s.
   Tabs: 점검 (LED / output waveform / PBS / battery) and 실험 (current sweep, phase sweep, manual).
   Add ?demo to the URL to try it without a board (simulated board, no Bluetooth). */
'use strict';

const SVC = '19b10100-e8f2-537e-4f6c-d104768a1214';
const CMD = '19b10101-e8f2-537e-4f6c-d104768a1214';
const STA = '19b10102-e8f2-537e-4f6c-d104768a1214';
const FW  = '19b10103-e8f2-537e-4f6c-d104768a1214';
let R_SENSE = 470;   // updated from the board's FW ID ("... R470" / "... R220")
const V_LIMIT = 30, BAT_LOW = 3.5, STALE_MS = 2000;
const DEMO = new URLSearchParams(location.search).has('demo');

const MENU = [
  {id:'led', n:1, t:'LED Test'},
  {id:'scope', n:2, t:'Output Waveform Test'},
  {id:'pbs', n:3, t:'PBS Test'},
  {id:'safe', n:4, t:'Battery Test'},
  {id:'trig', n:5, t:'Trigger LED Test'}
];
const TRIG_MS = 5*1240;   // firmware 'T': dim 1 s + bright 240 ms, 5 times
let trigUntil = 0;
function trigTest(){
  if(run || !B.connected || Date.now()<trigUntil) return;
  send('T').then(()=>{ trigUntil = Date.now()+TRIG_MS; addLog('chk',{id:'TRIG', cond:'D1 LED · 출력 없음', res:'na'}); render();
    setTimeout(render, TRIG_MS+50); }).catch(()=>toast('명령을 보내지 못했어요'));
}
const SWEEP = {C:{steps:[0.5,1.0,1.5,2.0,2.5,3.0].map(i=>({I:i,pw:500}))}, P:{steps:[100,200,300,400,500].map(w=>({I:3.0,pw:w}))}};
const GRID_I = [0.5,1.0,1.5,2.0,2.5,3.0], GRID_PW = [100,200,300,400,500];
const E = {sweep:'G', step:0, done:{C:[],P:[],G:[]}, hist:[], mcount:0, man:null, rat:null, el:null, edit:null, gi:5, gp:4};
/* 11/24 decision: period fixed at 1.2 ms (also in the phase sweep); gap between bursts is tested at the start. */
const PERIOD_US = 1200, GAPS = [1,3,5,7,9];
let WAVE = {gapS:3, order:'A'};   // order A = + phase first (Prof. Jeong's setup), C = − first
try{ const w=JSON.parse(localStorage.getItem('tes-yonsei-wave2')||'null'); if(w&&GAPS.includes(w.gapS)) WAVE={gapS:w.gapS, order:'A'}; }catch(e){}   // + first is fixed (11/24)
function saveWave(){ try{ localStorage.setItem('tes-yonsei-wave2', JSON.stringify(WAVE)); }catch(e){} }
// short form (BLE writes are limited to 20 bytes): B<I>,<pw>,<n>,<gap s>[,C]  e.g. B30,500,5,3
const bArgs = (i10,pw,n) => `B${i10},${pw},${n},${WAVE.gapS}${WAVE.order==='C'?',C':''}`;
const periodMs = () => PERIOD_US/1000;
const S = {screen:'menu', mode:'1 session', I:3.0, pw:500, R:4.7, logOpen:null, confirm:false};
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
  if(DEMO){ sim = new SimBoard(onStatusText); B.connected=true; B.fw='tES-YONSEI v2 B0 R470 (demo)'; B.board='demo'; B.lastMs=Date.now(); render(); return; }
  if(!navigator.bluetooth){ toast('이 브라우저는 Bluetooth를 지원하지 않아요. Android Chrome에서 여세요.'); return; }
  try{
    const dev = await navigator.bluetooth.requestDevice({filters:[{services:[SVC]}]});
    dev.addEventListener('gattserverdisconnected', onDisconnected);
    gatt = await dev.gatt.connect();
    const svc = await gatt.getPrimaryService(SVC);
    cmdChar = await svc.getCharacteristic(CMD);
    try{ B.fw = new TextDecoder().decode(await (await svc.getCharacteristic(FW)).readValue()); }catch(e){ B.fw='?'; }
    const m = /B(\d+)/.exec(B.fw); B.board = m ? m[1] : '?';
    const r = / R(\d+)/.exec(B.fw); if(r) R_SENSE = +r[1];
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
  if(S.screen==='led'){ cmd=`L100,500`; kind='led'; bursts=0; }
  else if(S.screen==='scope'){
    if(S.mode==='HOLD +') { cmd=`H+${i10}`; kind='hold'; bursts=0; }
    else if(S.mode==='HOLD −') { cmd=`H-${i10}`; kind='hold'; bursts=0; }
    else { bursts = S.mode==='1 burst'?1:5; cmd=bArgs(i10,S.pw,bursts); }
  }
  else if(S.screen==='pbs'){ cmd=bArgs(i10,S.pw,5); }
  else if(S.screen==='safe'){ cmd=bArgs(30,500,5); kind='bat'; sessions=BAT_RUNS; }
  else if(S.screen==='exp'){ cmd=bArgs(i10,S.pw,5); }
  run = {kind, screen:S.screen, cmd, bursts, sessions, done:0, started:false, worst:null,
         id: S.screen==='exp' ? expId() : {led:'LED',scope:'WAVE',pbs:'PBS',safe:'BAT'}[S.screen],
         cond: cond(), batStart:B.bat, I:S.I, pw:S.pw, sweep:E.sweep, step:E.sweep==='G'?`${E.gi},${E.gp}`:E.step};
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
    if(completed && r.sweep!=='M' && r.sweep!=='G'){           // same condition in Grid counts too
      const k=`${GRID_I.indexOf(r.I)},${GRID_PW.indexOf(r.pw)}`; if(!k.includes('-1') && !E.done.G.includes(k)) E.done.G.push(k); }
    if(r.sweep==='G'){ const h=E.hist.filter(x=>x!==r.step); h.push(r.step); if(h.length>2) h.shift(); E.hist.splice(0,E.hist.length,...h); }
    if(completed && r.sweep==='G'){
      const [ci,pi]=r.step.split(',').map(Number);
      if(pi===4 && !E.done.C.includes(ci)) E.done.C.push(ci);
      if(ci===5 && !E.done.P.includes(pi)) E.done.P.push(pi);
    }
    saveExp();
  }
}
const fmtV = v => v==null ? '?' : v.toFixed(2)+' V';
function cond(){
  if(S.screen==='led') return '10 mA · ± 교대';
  if(S.screen==='safe') return `1 session × ${BAT_RUNS}`;
  if(S.screen==='scope' && S.mode.startsWith('HOLD')) return `${S.mode} ${S.I.toFixed(1)} mA`;
  const base = `${S.I.toFixed(1)} mA · ${S.pw} µs`;
  if(S.screen==='scope') return base + ` · ${S.R}k${S.mode==='1 burst'?' · 1b':' · '+WAVE.gapS+'s'}`;
  return base + ` · ${WAVE.gapS}s${WAVE.order==='C'?' · −먼저':''}`;
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
    const f = WAVE.order==='A' ? -1 : 1, s1 = f<0?'+':'−', s2 = f<0?'−':'+';   // SVG y grows downward
    pts=`10,60 ${x0},60 ${x0},${60+f*h} ${x0+w},${60+f*h} ${x0+w},${60-f*h} ${x0+2*w},${60-f*h} ${x0+2*w},60 290,60`;
    const yLo=60+h+13, yHi=60-h-4;
    txt=`<text x="${x0+4}" y="${f>0?yLo:yHi}">${s1}${I.toFixed(1)} mA · ${pw} µs</text><text x="${x0+w+4}" y="${f>0?yHi:yLo}">${s2}${I.toFixed(1)} mA</text>`;
  }
  const Q=(I*pw/1000).toFixed(2);
  const session = S.screen!=='scope' || S.mode==='1 session';
  const info = hold ? `<span>전류 <b>${I.toFixed(1)} mA</b></span><span>V<sub>sense</sub> <b>${(I*R_SENSE/1000).toFixed(2)} V</b></span>`
    : `<span><b>주기 1.2 ms</b></span><span>${session?`200 pulse × 5 burst, 간격 ${WAVE.gapS} s`:'200 pulse'}</span><span>Q <b>${Q} µC</b></span>`;
  return `<div class="scope"><svg viewBox="0 0 300 120" role="img" aria-label="설정한 파형"><line x1="0" y1="60" x2="300" y2="60" stroke="var(--grid)" stroke-dasharray="3 3"/><polyline points="${pts}" fill="none" stroke="var(--wave)" stroke-width="2"/>${txt}</svg><div class="readout">${info}</div></div>`;
}
/* One session = 5 bursts of 240 ms, gap = end of a burst to start of the next. */
function sessionPlot(g){
  const BL=0.24, T=5*BL+4*g, x0=14, W=276, k=W/T, y0=46, h=26, bw=Math.max(4, BL*k);
  let bars='', arrows='';
  for(let i=0;i<5;i++){
    const x=x0+i*(BL+g)*k;
    bars+=`<rect x="${x.toFixed(1)}" y="${y0-h}" width="${bw.toFixed(1)}" height="${2*h}" fill="var(--wave)"/>`+
          `<text x="${(x+bw/2).toFixed(1)}" y="${y0-h-5}" text-anchor="middle">B${i+1}</text>`;
    if(i<4){ const a=x+bw+2, b=x0+(i+1)*(BL+g)*k-2;
      arrows+=`<line x1="${a.toFixed(1)}" y1="${y0+h+9}" x2="${b.toFixed(1)}" y2="${y0+h+9}" stroke="var(--muted)" marker-start="url(#ah)" marker-end="url(#ah)"/>`+
              `<text x="${((a+b)/2).toFixed(1)}" y="${y0+h+22}" text-anchor="middle" fill="var(--muted)">${g} s</text>`; }
  }
  return `<div class="scope" style="padding:8px"><svg viewBox="0 0 300 112" role="img" aria-label="1 session 파형">`+
    `<defs><marker id="ah" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L6,3 L0,6" fill="none" stroke="var(--muted)"/></marker></defs>`+
    `<line x1="0" y1="${y0}" x2="300" y2="${y0}" stroke="var(--grid)" stroke-dasharray="3 3"/>${bars}${arrows}</svg>`+
    `<div class="readout"><span>burst 240 ms × 5</span><span>1 session <b>${T.toFixed(1)} s</b></span></div></div>`;
}
/* Small waveform for the 실험 card: two pulse periods (1.2 ms each) to scale, + phase first, amplitude ∝ current. */
function miniWave(I, pw){
  const P=PERIOD_US, k=84/P, h=4+20*I/3, y=34, x0=8; let d=`M0,${y} L${x0},${y}`;
  for(let n=0;n<2;n++){ const x=x0+n*P*k, a=x+pw*k, b=a+pw*k;
    d+=` L${x},${y-h} L${a.toFixed(1)},${y-h} L${a.toFixed(1)},${y+h} L${b.toFixed(1)},${y+h} L${b.toFixed(1)},${y} L${(x+P*k).toFixed(1)},${y}`; }
  return `<svg class="mini" viewBox="0 0 186 68" role="img" aria-label="파형"><line x1="0" y1="${y}" x2="186" y2="${y}" stroke="var(--grid)" stroke-dasharray="3 3"/>`+
    `<path d="${d} L186,${y}" fill="none" stroke="var(--wave)" stroke-width="2"/><text x="186" y="66" text-anchor="end">1.2 ms 주기</text></svg>`;
}
/* Target current of the running output (mA). LED test asks 10 mA, capped by the board's R_sense (ref max 2.9 V). */
function runTargetMA(){
  if(!run) return null;
  if(run.kind==='led') return Math.min(10, Math.floor(2.9/R_SENSE*10000)/10);
  if(run.kind==='bat') return 3.0;
  return run.I;
}
function measTag(){
  if(B.pct==null) return '';
  const g=grade(B.pct), t=runTargetMA();
  const mA = t==null ? '' : ` · <b>${(B.pct*t/100).toFixed(2)} mA</b>`;
  return `<span class="meas"><i style="background:${LAMP[g]}"></i>실제 전류 ${GTXT[g]}${mA} (${B.pct} %)</span>`;
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
  const lbl = st==='G' ? `burst ${B.burst}/5 끝 · 다음 burst까지 ${WAVE.gapS} s` : `burst ${B.burst}/5 · pulse ${B.pulse}/200`;
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
function logBlock(k, nShow=3){
  const v=LOG[k].view, runs=v.filter(r=>!r.sep).length;
  return `<div><div class="loghead"><span class="lbl">Log</span><span class="acts">${runs?`<button type="button" data-logopen="${k}">전체 ${runs}회 ›</button>`:''}</span></div>`+
    `<div class="log prev" data-logopen="${k}">${v.length?v.slice(-nShow).reverse().map(r=>rowHTML(r,false)).join(''):'<span class="muted">없음</span>'}</div></div>`;
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
  // Status notifications re-render the screen several times a second. While a number box is open and being typed in
  // (Rat / Electrode number, Manual mA / µs), keep the screen as it is so the phone keyboard stays open.
  const ae = document.activeElement;
  if((E.edit || E.man) && ae && ae.tagName==='INPUT' && m.contains(ae)) return;
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
      `<div class="readout"><span>고정: <b>약 10 mA</b> · 500 µs pulse (470 Ω 보드는 약 6 mA까지)</span><span>− 방향 0.5 s → + 방향 0.5 s 번갈아 반복</span><span style="color:var(--warn)">LED 지그 전용 · 동물에 연결하지 마세요</span></div>` +
      progress() + runBtn('깜빡이기 시작') + logBlock('chk');
  } else if(S.screen==='scope'){
    const V=(S.I*S.R).toFixed(1);
    m.innerHTML = head('2 · Output Waveform Test') +
      chips('출력 방식','mode',['HOLD +','HOLD −','1 burst','1 session']) +
      chips('전류 (mA)','I',[0.5,1.0,1.5,2.0,2.5,3.0],v=>v.toFixed(1)) +
      chips('Phase (µs)','pw',[100,200,300,400,500],v=>v,()=>S.mode.startsWith('HOLD')) +
      chips('부하 저항 (kΩ)','R',[1,4.7,10,15]) +
      wave() + `<div class="readout"><span>scope 예상: 저항 양단 <b>±${V} V</b></span>${S.I*S.R>V_LIMIT?'<span style="color:var(--warn)">전압 한계(약 30 V) 넘음 · 전류가 덜 나와요</span>':''}</div>` +
      progress() + runBtn(S.mode.startsWith('HOLD')?'HOLD 시작 (30 s)':'출력') + logBlock('chk');
  } else if(S.screen==='pbs'){
    m.innerHTML = head('3 · PBS Test') +
      chips('전류 (mA)','I',[0.5,1.0,1.5,2.0,2.5,3.0],v=>v.toFixed(1)) +
      chips('Phase (µs)','pw',[100,200,300,400,500]) +
      wave() + progress() + runBtn('1 session 출력') + logBlock('chk');
  } else if(S.screen==='safe'){
    m.innerHTML = head('4 · Battery Test') +
      `<div class="readout"><span>지금 배터리 <b>${fmtV(B.bat)}</b></span><span>3.0 mA · 500 µs · 1 session × ${BAT_RUNS}</span></div>` +
      progress() + runBtn(`하루치 반복 시작 (1 session × ${BAT_RUNS})`) + logBlock('chk');
  } else if(S.screen==='trig'){
    const busy = Date.now()<trigUntil;
    m.innerHTML = head('5 · Trigger LED Test') +
      `<div class="readout"><span>XIAO D1 표시 LED만 켜요 · <b>전극으로 전류는 안 나가요</b></span><span>1 session 모양: 어둡게 1 s → 밝게 0.24 s, 5번 (약 6 s)</span><span>실제 자극 때: burst 중 밝게 · burst 사이 어둡게 · STOP이면 꺼짐</span></div>` +
      (busy?`<div class="prog"><div class="lbl">D1 LED 깜빡이는 중…</div></div>`:'') +
      `<button type="button" class="btn" id="trig" ${busy||run||!B.connected?'disabled':''}>${busy?'깜빡이는 중…':'LED 깜빡이기 (약 6 s)'}</button>` + logBlock('chk');
  }
}

function expId(){ return E.sweep==='M' ? 'M' : ''; }
function elTxt(){ return E.el ? (E.el.type==='F'?'Flat ':'Porous ')+E.el.n : '—'; }
function renderExp(m){
  const dis = run ? 'disabled' : '';
  let who = `<div class="who"><button type="button" data-edit="rat" ${dis}><span>Rat</span><b>${E.rat??'—'}</b></button><button type="button" data-edit="el" ${dis}><span>Electrode</span><b>${elTxt()}</b></button></div>`;
  if(E.edit){
    const isEl=E.edit.k==='el';
    who = `<div class="edit"><div class="lbl" style="margin:0">${isEl?'Electrode':'Rat'} 번호</div>`+
      (isEl?`<div class="seg" style="grid-template-columns:1fr 1fr">${[['F','Flat'],['P','Porous']].map(([k,t])=>`<button type="button" data-eltype="${k}" class="${E.edit.type===k?'on':''}">${t}</button>`).join('')}</div>`:'')+
      `<input id="numin" type="number" inputmode="numeric" min="1" value="${E.edit.n??''}" aria-label="번호">`+
      `<div class="row2"><button type="button" class="btn ghost" data-editcancel>취소</button><button type="button" class="btn" data-editok>확인</button></div></div>`;
  }
  const manual = E.sweep==='M';
  if(!run && !manual){ S.I=GRID_I[E.gi]; S.pw=GRID_PW[E.gp]; }
  const nLog = LOG.exp.view.filter(r=>!r.sep).length;
  const bar = `<div class="xbar"><button type="button" data-wopen ${dis}>Burst interval <b>${WAVE.gapS} s</b> ›</button><button type="button" data-mopen ${dis}>${manual?'<b>Manual</b>':'Manual'} ›</button><button type="button" data-logopen="exp">Log${nLog?' '+nLog:''} ›</button></div>`;
  const tier1 = (ci,pi) => pi===4 || ci===5;
  const last=E.hist[E.hist.length-1], prev=E.hist.length>1?E.hist[0]:null;
  const grid = `<div class="grid"><span></span>${GRID_I.map(i=>`<span class="gh">${i.toFixed(1)}<small>mA</small></span>`).join('')}`+
    GRID_PW.map((w,pi)=>`<span class="gh">${w}<small>µs</small></span>`+GRID_I.map((i,ci)=>{
      const k=`${ci},${pi}`, done=E.done.G.includes(k), cur=!manual&&ci===E.gi&&pi===E.gp;
      const h = k===last ? ' last' : k===prev ? ' prev' : '';
      return `<button type="button" class="cell${tier1(ci,pi)?' t1':''}${done?' done':''}${h}${cur?' cur':''}" data-cell="${k}" ${dis} aria-label="${i} mA ${w} µs">${done?'✓':''}</button>`;
    }).join('')).join('')+`</div>`;
  const card = `<button type="button" class="now2" data-wave>${manual?'<span class="mtag">Manual</span>':''}<span class="cond">${S.I.toFixed(1)}<small> mA</small></span><span class="cond">${S.pw}<small> µs</small></span></button>`;
  const waveModal = E.showWave ? `<div class="modal" data-waveclose><div class="box" style="text-align:left">${wave()}<button type="button" class="btn ghost" data-waveclose>닫기</button></div></div>` : '';
  const W = E.wmodal, M = E.man;
  const wModal = W ? `<div class="modal"><div class="box" style="text-align:left">`+
    `<div><div class="lbl">Burst interval</div><div class="chips">${GAPS.map(g=>`<button type="button" class="chip${g===W.gapS?' on':''}" data-gap="${g}">${g} s</button>`).join('')}</div></div>`+
    sessionPlot(W.gapS)+
    `<div class="row2"><button type="button" class="btn ghost" data-wcancel>취소</button><button type="button" class="btn" data-wok>확인</button></div></div></div>` : '';
  const mModal = M ? `<div class="modal"><div class="box" style="text-align:left"><b>Manual</b>`+
    `<div class="man"><label class="lbl">전류 (mA)<input id="manI" type="number" inputmode="decimal" min="0.5" max="3" step="0.1" value="${M.I.toFixed(1)}"></label>`+
    `<label class="lbl">Phase (µs)<input id="manPw" type="number" inputmode="numeric" min="50" max="500" step="10" value="${M.pw}"></label></div>`+
    `<div class="row2"><button type="button" class="btn ghost" data-mcancel>취소</button><button type="button" class="btn" data-mok>확인</button></div></div></div>` : '';
  const focus = document.activeElement && document.activeElement.id==='numin';
  m.innerHTML = who + bar + grid + card + (run ? progress() : '') +
    `<button type="button" class="btn big" id="run" ${run||!B.connected?'disabled':''}>${run?'출력 중…':'Start'}</button>` + wModal + mModal + waveModal;
  if(E.edit && !focus){ const i=$('numin'); if(i) i.focus(); }
}

const EXP_KEY = 'tes-yonsei-exp-v2';
function saveExp(){ try{ localStorage.setItem(EXP_KEY, JSON.stringify({rat:E.rat, el:E.el, marks:E.marks||{}, gi:E.gi, gp:E.gp, mcount:E.mcount})); }catch(e){} }
function bindMarks(){
  const key=`${E.rat??'-'}|${E.el?E.el.type+E.el.n:'-'}`;
  E.marks = E.marks || {};
  if(!E.marks[key]) E.marks[key]={done:{C:[],P:[],G:[]}, hist:[]};
  E.done=E.marks[key].done; E.hist=E.marks[key].hist;
}
try{ const v=JSON.parse(localStorage.getItem(EXP_KEY)||'null');
  if(v){ E.rat=v.rat??null; E.el=v.el??null; E.marks=v.marks||{}; if(Number.isInteger(v.gi)) E.gi=v.gi; if(Number.isInteger(v.gp)) E.gp=v.gp; E.mcount=v.mcount||0; } }catch(e){}
bindMarks();
function setWho(k, val){
  if(k==='rat') E.rat=val; else E.el=val;
  // Each Rat × electrode pair has its own grid marks: a new pair starts empty, going back shows its marks again.
  bindMarks(); saveExp();
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
  const c=T('.chip[data-k]'); if(c && !c.disabled){ const k=c.dataset.k, v=c.dataset.v; S[k]=isNaN(+v)?v:+v; render(); return; }
  const ed=T('[data-edit]'); if(ed && !ed.disabled){ const k=ed.dataset.edit; E.edit={k, n:k==='rat'?E.rat:E.el?.n, type:E.el?.type||'P'}; render(); return; }
  const et=T('[data-eltype]'); if(et){ E.edit.n=$('numin').value||null; document.activeElement.blur(); E.edit.type=et.dataset.eltype; render(); return; }
  if(T('[data-editcancel]')){ E.edit=null; render(); return; }
  if(T('[data-editok]')){ const n=parseInt($('numin').value,10); if(n>0){ setWho(E.edit.k, E.edit.k==='rat'?n:{type:E.edit.type,n}); } E.edit=null; render(); return; }
  const sw=T('[data-sw]'); if(sw && !sw.disabled){ E.sweep=sw.dataset.sw; render(); return; }
  const st=T('[data-st]'); if(st && !st.disabled){ E.step=+st.dataset.st; render(); return; }
  const cell=T('[data-cell]'); if(cell && !cell.disabled){ const [ci,pi]=cell.dataset.cell.split(',').map(Number); E.gi=ci; E.gp=pi; E.sweep='G'; saveExp(); render(); return; }
  if(T('[data-wave]')){ E.showWave=true; render(); return; }
  if(T('[data-waveclose]')){ E.showWave=false; render(); return; }
  if(T('[data-wopen]') && !run){ E.wmodal={gapS:WAVE.gapS}; render(); return; }
  const gp=T('[data-gap]'); if(gp && E.wmodal){ E.wmodal.gapS=+gp.dataset.gap; render(); return; }
  if(T('[data-wcancel]')){ E.wmodal=null; render(); return; }
  if(T('[data-wok]')){ const g=E.wmodal.gapS; E.wmodal=null;
    if(g!==WAVE.gapS){ WAVE.gapS=g; saveWave();
      const sep=`Burst interval ${g} s`; LOG.exp.view.push({sep}); LOG.exp.all.push({sep,t:nowT(),d:new Date().toISOString()}); saveLog(); }
    render(); return; }
  if(T('[data-mopen]') && !run){ E.man={I:S.I, pw:S.pw}; render(); return; }
  if(T('[data-mcancel]')){ E.man=null; render(); return; }
  if(T('[data-mok]')){ applyManual(); E.man=null; E.sweep='M'; render(); return; }
  if(T('#run')) startRun();
  if(T('#trig')) trigTest();
});
document.addEventListener('keydown', e=>{ if(e.key==='Enter' && e.target.id==='numin') document.querySelector('[data-editok]').click(); });
$('stop').addEventListener('click', stopNow);
function applyManual(){
  const a=$('manI'), b=$('manPw'); if(!a||!b) return;   // Manual popup -> current condition
  let v=Math.round(+a.value*10)/10; if(!(v>=0.5)) v=0.5; if(v>3) v=3; S.I=v;
  let w=Math.round(+b.value/10)*10; if(!(w>=50)) w=50; if(w>500) w=500; S.pw=w;
}

/* ---------------- demo board (?demo) ---------------- */
class SimBoard {
  constructor(cb){ this.cb=cb; this.t=0; this.st='0'; this.burst=0; this.pulse=0; this.pct=null; this.bat=395; this.reason='P'; this.tick=setInterval(()=>this.step(),200); this.emit(); }
  emit(){ this.cb(`${this.st},${this.burst},${this.pulse},${this.pct??'-'},${this.bat},${this.st==='0'?this.reason:'-'}`); }
  write(t){
    const c=t[0];
    if(c==='?'){ this.emit(); return; }
    if(c==='S'||c==='0'){ this.stop('U'); return; }
    if(this.st!=='0'){ this.stop('E'); return; }
    if(c==='T') return;   // trigger-LED test: no output
    this.pct=null; this.burst=0; this.pulse=0; this.t=0;
    if(c==='B'){ const f=t.slice(1).split(','), n=+f[2], v=+f[3]; this.n=n; this.gap = !v ? 3000 : v<=30 ? v*1000 : (+f[4]||3000); this.mode='B'; }
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
    else if(this.st==='G' && this.t>=this.gap){ this.st='B'; this.burst++; this.pulse=0; }
    else if(this.st==='L'){ this.pct=99; if(this.t%600<200) this.burst=this.burst===1?2:1; if(this.t>=120000){ this.stop('T'); return; } }
    else if(this.st==='H'){ this.pct=100; if(this.t>=30000){ this.stop('T'); return; } }
    this.emit();
  }
}

if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
render();
