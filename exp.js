'use strict';
/* tES experiment app v1 — pairs with firmware tES-EXP v1 (1 kHz biphasic, 0.5–2 mA).
   Same BLE service as the diagnostic app. Bench use only, resistor load. */

const SVC = '19b10000-e8f2-537e-4f6c-d104768a1214';
const CMD = '19b10001-e8f2-537e-4f6c-d104768a1214';
const STATUS = '19b10002-e8f2-537e-4f6c-d104768a1214';
const FW = '19b10003-e8f2-537e-4f6c-d104768a1214';
const FW_EXPECTED = 'tES-EXP v1';
const R_SENSE = 470;
const STORE_KEY = 'tes-exp-v1';
const CUR_CMD = { 5: 'l', 10: 'm', 15: 'n', 20: 'h' };
const LOADS = [['1k', 1000], ['4k7', 4700], ['10k', 10000], ['15k', 15000], ['22k', 22000], ['33k', 33000], ['47k', 47000]];
const RL_NOM = Object.fromEntries(LOADS);

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

let device = null, cmdChar = null, statusChar = null, fwId = '';
let writeQueue = Promise.resolve();
let live = { state: null, x10: 10, sec: 0, reason: '-' };
let tab = 'ctl', runFilter = 'todo';
const openItems = new Set();

/* ---------- stored data ---------- */
function blank() { return { tests: {}, run: {}, rl: {} }; }
function load() {
  try { const d = JSON.parse(localStorage.getItem(STORE_KEY)); return d && d.run ? d : blank(); } catch (e) { return blank(); }
}
let db = load();
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); } catch (e) {} }

/* ---------- measurement plan (protocol 2026-10-29) ---------- */
function buildPlan() {
  const p = [];
  p.push({ id: 'M5_vboost', kind: 'manual', meas: 'M5', title: 'M5 · V_boost (rail) DMM',
    how: '① STOP 상태에서 V_boost를 DMM으로 측정. ② 2.0 mA START 후 출력 중 V_boost 측정.',
    fields: [['vboost_stop', 'V_boost, STOP', 'V'], ['vboost_2mA', 'V_boost, 2.0 mA 출력 중', 'V']], startX10: 20 });
  p.push({ id: 'M4_cal', kind: 'manual', meas: 'M4', title: 'M4 · scope gain 보정',
    how: 'STOP 상태. 두 probe를 모두 V_boost 지점에 대고, 같은 순간에 scope CH1·CH2 평균값과 DMM 값을 읽는다.',
    fields: [['V_boost_DMM_V', 'DMM', 'V'], ['V_boost_scope_CH1_V', 'Scope CH1 mean', 'V'], ['V_boost_scope_CH2_V', 'Scope CH2 mean', 'V']] });
  for (let r = 1; r <= 3; r++) {
    const R = 'R0' + r;
    p.push({ id: `M1M2_${R}_fwd`, kind: 'cap', meas: 'M1M2', x10: 10, rl: '10k', run: R, orient: 'fwd', restart: 'power', wait: 60,
      how: '배터리를 뺐다 끼워 전원 off → on → 앱 다시 연결 → START → V_bat 측정 → 60 s 대기. CH1 = E+, CH2 = E−. 5 V/div, 10 ms/div.' });
    p.push({ id: `M1M2_${R}_swap`, kind: 'cap', meas: 'M1M2', x10: 10, rl: '10k', run: R, orient: 'swap', restart: 'none', wait: 60,
      how: '출력은 그대로 두고 두 probe 위치만 서로 바꿔서 캡처 (CH1 = E−, CH2 = E+).' });
    if (r === 1) p.push({ id: 'M1_edge_R01_fwd', kind: 'cap', meas: 'M1edge', x10: 10, rl: '10k', run: R, orient: 'fwd', restart: 'none', wait: 60,
      how: 'probe를 fwd로 되돌린 뒤, 0 A → + 시작점 확대: 2 V/div, 2 µs/div, 최대 sampling.' });
  }
  for (const [rl] of LOADS) for (const x10 of [10, 20]) for (let r = 1; r <= 3; r++) {
    p.push({ id: `M3_I${x10 / 10}mA_R${rl}_run${r}`, kind: 'cap', meas: 'M3', x10, rl, run: r, orient: 'fwd', restart: 'stopstart', wait: 10,
      how: (r === 1 && x10 === 10 ? `STOP 상태에서 R_L을 ${rl}로 바꿔 단다. ` : '') + 'STOP → START → 10 s 대기 → 캡처. 5 V/div, 500 µs/div.' +
        (rl === '1k' ? ' 1 kΩ은 전압 차가 작으니 가능하면 vertical offset + 작은 V/div.' : '') });
  }
  for (const x10 of [5, 15]) for (let r = 1; r <= 3; r++) {
    p.push({ id: `M4_I${String(x10 / 10).replace('.', 'p')}mA_R10k_run${r}`, kind: 'cap', meas: 'M4', x10, rl: '10k', run: r, orient: 'fwd', restart: 'stopstart', wait: 10,
      how: (r === 1 && x10 === 5 ? 'R_L을 10k로 바꿔 단다. ' : '') + 'STOP → START → 10 s 대기 → 캡처. M3와 같은 scope 설정.' });
  }
  return p;
}
const PLAN = buildPlan();
const CAPS = PLAN.filter(i => i.kind === 'cap');

/* ---------- bench tests ---------- */
const TESTS = [
  { id: 'fw', title: 'Firmware 확인', text: `연결 후 Firmware 칸이 "${FW_EXPECTED}"인지 확인.`, auto: true },
  { id: 'ref', title: 'Reference 전압 (1.0 mA)', text: '1.0 mA 선택 → REF 버튼 → 5초 뒤 RC capacitor(OPA320 +IN) 전압을 DMM으로. 기대 0.470 V (±1 %). 12-bit PWM이 맞게 동작하는지 보는 단계.',
    acts: [['1.0 mA', ['0', 'm']], ['REF 켜기', ['0', 'm', 'r']]], fields: [['vref', 'V_ref', 'V']] },
  { id: 'wave', title: '파형 모양 (1.0 mA, 10 kΩ)', text: 'START. Scope MATH = CH1 − CH2로 보면 쉽다. 주기 1.000 ms, + 250 µs → − 250 µs → 0 V 500 µs, 진폭 약 ±10 V.',
    acts: [['1.0 mA START', ['0', 'm', 'p']]], fields: [['period_ms', '주기', 'ms'], ['amp_pos', '+ 진폭', 'V'], ['amp_neg', '− 진폭 (절댓값)', 'V']] },
  { id: 'ble', title: 'BLE 연결 중 timing 안정', text: '출력을 켠 채 60 s 이상 둔다. Scope trigger가 흔들리지 않고 주기·폭이 그대로면 통과. (폰을 움직이거나 앱 화면을 바꿔봐도 그대로여야 함)' },
  { id: 'high', title: '2.0 mA 출력', text: 'STOP → 2.0 mA → START. 10 kΩ에서 진폭 약 ±20 V.',
    acts: [['2.0 mA START', ['0', 'h', 'p']]], fields: [['amp_2mA', '진폭', 'V']] },
  { id: 'stop', title: 'STOP·연결 끊김 시 정지', text: '① STOP 버튼 → 출력 0 V. ② 다시 START 후 폰 Bluetooth를 끄면 출력 0 V (펌웨어 자동 STOP). ③ Bluetooth 켜고 다시 연결.' },
  { id: 'csv', title: 'Scope CSV 형식 확인', text: '1.0 mA 출력을 한 번 캡처해 USB에 CSV로 저장 → PC로 옮겨 Claude에게 보낸다. 분석 스크립트가 읽히는지 확인한 다음 본실험 시작.',
    fields: [['csv_name', 'Scope 파일 이름', '', 'text']] },
  { id: 'bat', title: '배터리', text: '본실험 시작 직전 V_bat. 3.9 V 이상 권장 (낮으면 충전 후 시작).', fields: [['vbat', 'V_bat', 'V']] },
];

function judgeTest(t, v) {
  if (t.id === 'ref' && v.vref != null) {
    const e = (v.vref - 0.47) / 0.47 * 100;
    return Math.abs(e) <= 1 ? ['ok', `오차 ${e.toFixed(2)} % — 통과`] : ['warn', `오차 ${e.toFixed(2)} % — 1 %보다 큼. 3.3 V 전원 실제값을 DMM으로 재서 알려주세요.`];
  }
  if (t.id === 'wave' && v.period_ms != null) {
    const okP = Math.abs(v.period_ms - 1) <= 0.01;
    const amps = [v.amp_pos, v.amp_neg].filter(x => x != null);
    const okA = amps.every(a => Math.abs(a - 10) / 10 <= 0.05);
    return okP && okA ? ['ok', '주기·진폭 정상'] : ['warn', (okP ? '' : '주기가 1.000 ms ±1 % 밖. ') + (okA ? '' : '진폭이 ±10 V의 ±5 % 밖.')];
  }
  if (t.id === 'high' && v.amp_2mA != null) {
    return Math.abs(v.amp_2mA - 20) / 20 <= 0.05 ? ['ok', '2 mA 정상'] : ['warn', '±20 V의 ±5 % 밖. V_boost가 출력 중 처지는지 확인.'];
  }
  if (t.id === 'bat' && v.vbat != null) return v.vbat >= 3.9 ? ['ok', '충분'] : ['warn', '충전 후 시작 권장'];
  return null;
}

/* ---------- BLE ---------- */
function notice(text, bad = false) {
  const n = $('#notice');
  if (!text) { n.hidden = true; return; }
  n.textContent = text; n.className = 'notice' + (bad ? ' bad' : ''); n.hidden = false;
}

async function connect() {
  if (!navigator.bluetooth) { notice('이 브라우저는 Bluetooth를 지원하지 않습니다. Android Chrome에서 여세요.', true); return; }
  try {
    notice('');
    setBadge('busy', '연결 중…');
    device = await navigator.bluetooth.requestDevice({ filters: [{ services: [SVC] }] });
    device.addEventListener('gattserverdisconnected', onDisconnected);
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService(SVC);
    cmdChar = await svc.getCharacteristic(CMD);
    statusChar = await svc.getCharacteristic(STATUS);
    try { fwId = new TextDecoder().decode(await (await svc.getCharacteristic(FW)).readValue()); } catch (e) { fwId = '?'; }
    statusChar.addEventListener('characteristicvaluechanged', ev => parseStatus(ev.target.value));
    await statusChar.startNotifications();
    parseStatus(await statusChar.readValue());
    setConnected(true);
    if (fwId !== FW_EXPECTED) notice(`보드 펌웨어가 "${fwId}"입니다. 1 kHz 출력에는 tES_Exp_v1.ino가 필요합니다.`, true);
    else { setTest('fw', true); }
  } catch (e) {
    setConnected(false);
    notice(e.name === 'NotFoundError' ? '기기 선택이 취소되었습니다.' : '연결 실패: ' + e.message, e.name !== 'NotFoundError');
  }
}

function onDisconnected() {
  setConnected(false);
  notice('연결이 끊겼습니다. 펌웨어는 연결이 끊기면 자동으로 STOP 합니다.');
}

function send(ch) {
  if (!cmdChar) return Promise.resolve();
  const p = writeQueue.then(() => cmdChar.writeValueWithResponse(Uint8Array.of(ch.charCodeAt(0))));
  writeQueue = p.catch(() => {});
  return p.catch(e => notice('명령 전송 실패: ' + e.message, true));
}
const sendSeq = cmds => cmds.reduce((p, c) => p.then(() => send(c)), Promise.resolve());
const startAt = x10 => sendSeq(['0', CUR_CMD[x10], 'p']);

function parseStatus(dv) {
  const [st, x10, sec, , reason] = new TextDecoder().decode(dv).trim().split(',');
  live = { state: st, x10: Number(x10) || 0, sec: Number(sec) || 0, reason: reason || '-' };
  renderLive();
}

/* ---------- live view ---------- */
const STATE_TEXT = { '0': 'STOP', R: 'REF only', W: '안정화 중…', A: 'HOLD A', B: 'HOLD B', S: 'SLOW', P: '1 kHz 출력 중' };
const REASON_TEXT = { U: '사용자', T: '자동 정지', F: 'SLOW 완료', D: '연결 끊김', P: '전원 켜짐', '-': '' };

function setBadge(cls, text) { const b = $('#connBadge'); b.className = 'badge ' + cls; b.textContent = text; }

function setConnected(on) {
  if (!on) { cmdChar = null; statusChar = null; live.state = null; }
  setBadge(on ? 'on' : 'off', on ? '연결됨' : '연결 안 됨');
  $('#connectBtn').hidden = on;
  $('#disconnectBtn').hidden = !on;
  $('#live').hidden = !on;
  $('#stopBtn').disabled = !on;
  $('#fwId').textContent = on ? fwId : '-';
  renderLive();
  renderRun();
  renderTests();
}

function currentItem() { return PLAN.find(i => !(db.run[i.id] && db.run[i.id].done)); }

function renderLive() {
  const s = live.state;
  $('#liveState').textContent = s == null ? '-' : (STATE_TEXT[s] || s) + (s === '0' && REASON_TEXT[live.reason] ? ` · ${REASON_TEXT[live.reason]}` : '');
  $('#liveCurrent').textContent = (live.x10 / 10).toFixed(1) + ' mA';
  $('#liveTime').textContent = s === 'P' ? `${live.sec} s` : '-';
  $$('#currentChips button').forEach(b => {
    b.classList.toggle('sel', Number(b.dataset.x10) === live.x10);
    b.disabled = !cmdChar || s !== '0';
  });
  $('#pulseBtn').disabled = !cmdChar;
  $('#expRef').textContent = (live.x10 / 10 * 1e-3 * R_SENSE).toFixed(3) + ' V';
  $('#expVL').textContent = (live.x10 / 10 * 10).toFixed(0) + ' V';

  const r = $('#ready');
  const cur = currentItem();
  const wait = tab === 'run' && cur && cur.kind === 'cap' ? cur.wait : 10;
  if (!cmdChar) { r.hidden = true; }
  else if (s === 'P') {
    r.hidden = false;
    r.className = 'ready ' + (live.sec >= wait ? 'go' : 'wait');
    r.textContent = live.sec >= wait ? `캡처 OK (출력 ${live.sec} s ≥ ${wait} s)` : `대기 중 ${live.sec} / ${wait} s`;
  } else if (s === 'W') { r.hidden = false; r.className = 'ready wait'; r.textContent = 'Reference 안정화 중 (1 s)'; }
  else { r.hidden = false; r.className = 'ready off'; r.textContent = '출력 없음'; }
  // keep the wait shown on the current run item in sync
  const w = $('#runList .item.cur .warnline.live');
  if (w) w.textContent = liveCheck(cur).join(' ');
}

/* ---------- tests UI ---------- */
function setTest(id, done) { db.tests[id] = Object.assign(db.tests[id] || {}, { done }); save(); renderTests(); }

function inputRow(k, label, unit, val, type) {
  const isText = type === 'text';
  return `<label class="in"><span>${label}${unit ? ` <small>${unit}</small>` : ''}</span>` +
    `<input data-k="${k}" ${isText ? 'type="text"' : 'type="number" step="0.001" inputmode="decimal"'} value="${val == null ? '' : String(val).replace(/"/g, '&quot;')}"></label>`;
}

function renderTests() {
  const box = $('#testList');
  box.innerHTML = TESTS.map((t, n) => {
    const st = db.tests[t.id] || {};
    const v = st.values || {};
    const j = judgeTest(t, v);
    return `<div class="test${st.done ? ' done' : ''}" data-id="${t.id}">
      <label class="test-head"><input type="checkbox" ${st.done ? 'checked' : ''}><span><b>T${n + 1}. ${t.title}</b><p>${t.text}</p></span></label>
      ${t.acts ? `<div class="acts">${t.acts.map((a, i) => `<button data-act="${i}" ${cmdChar ? '' : 'disabled'}>${a[0]}</button>`).join('')}</div>` : ''}
      ${(t.fields || []).map(f => inputRow(f[0], f[1], f[2], v[f[0]], f[3])).join('')}
      ${j ? `<div class="verdict ${j[0]}" style="margin-left:32px">${j[1]}</div>` : ''}
    </div>`;
  }).join('');
}

function onTestEvent(e) {
  const card = e.target.closest('.test'); if (!card) return;
  const t = TESTS.find(x => x.id === card.dataset.id);
  const st = db.tests[t.id] = db.tests[t.id] || {};
  if (e.type === 'change' && e.target.type === 'checkbox') { st.done = e.target.checked; save(); renderTests(); return; }
  if (e.type === 'change' && e.target.dataset.k) {
    st.values = st.values || {};
    const raw = e.target.value;
    st.values[e.target.dataset.k] = raw === '' ? null : e.target.type === 'number' ? Number(raw) : raw;
    save(); renderTests(); return;
  }
  if (e.type === 'click' && e.target.dataset.act != null) sendSeq(t.acts[Number(e.target.dataset.act)][1]);
}

/* ---------- run sheet ---------- */
function condText(i) {
  if (i.kind !== 'cap') return '';
  const ohm = db.rl[i.rl];
  return `${(i.x10 / 10).toFixed(1)} mA · R_L ${i.rl}${ohm ? ` (${ohm} Ω)` : ''} · run ${i.run} · ${i.orient}`;
}

function liveCheck(i) {
  if (!i || i.kind !== 'cap') return [];
  const w = [];
  if (!cmdChar) w.push('연결 안 됨.');
  else {
    if (live.state !== 'P') w.push('출력 중이 아님.');
    if (live.x10 !== i.x10) w.push(`전류가 ${(live.x10 / 10).toFixed(1)} mA (필요 ${(i.x10 / 10).toFixed(1)} mA).`);
    if (live.state === 'P' && live.sec < i.wait) w.push(`대기 ${live.sec}/${i.wait} s.`);
  }
  return w;
}

function nextScopeName() {
  const done = PLAN.map(i => db.run[i.id]).filter(r => r && r.scope).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  const last = done.length ? done[done.length - 1].scope : '';
  const m = last.match(/^(.*?)(\d+)(\D*)$/);
  if (!m) return '';
  return m[1] + String(Number(m[2]) + 1).padStart(m[2].length, '0') + m[3];
}

function renderRun() {
  const cur = currentItem();
  const nDone = CAPS.filter(i => db.run[i.id] && db.run[i.id].done).length;
  $('#runCount').textContent = `캡처 ${nDone} / ${CAPS.length}`;
  const list = PLAN.filter(i => runFilter === 'all' || !(db.run[i.id] && db.run[i.id].done));
  $('#runList').innerHTML = list.map(i => {
    const r = db.run[i.id] || {};
    const isCur = cur && i.id === cur.id;
    const open = isCur || openItems.has(i.id);
    const tag = r.done ? '<span class="tag ok">완료</span>' : isCur ? '<span class="tag">지금</span>' : `<span class="tag">${i.meas}</span>`;
    let body = `<p class="how">${i.how}</p>`;
    if (i.kind === 'cap') {
      body += `<p class="cond">${condText(i)}</p>`;
      body += inputRow('scope', 'Scope 파일', '', r.scope != null ? r.scope : (isCur ? nextScopeName() : ''), 'text');
      if (i.restart === 'power') body += inputRow('vbat', 'V_bat', 'V', r.vbat);
      body += inputRow('note', '메모', '', r.note, 'text');
      const acts = [];
      if (i.restart !== 'none') acts.push(`<button data-do="start" ${cmdChar ? '' : 'disabled'}>${i.restart === 'power' ? '' : 'STOP → '}START ${(i.x10 / 10).toFixed(1)} mA</button>`);
      acts.push(r.done ? '<button data-do="undo" class="ghost">되돌리기</button>' : '<button data-do="done" class="primary">캡처 기록</button>');
      body += `<div class="acts">${acts.join('')}</div>`;
      if (isCur) body += `<div class="warnline live">${liveCheck(i).join(' ')}</div>`;
      if (r.done) body += `<div class="log">${new Date(r.time).toLocaleTimeString('ko-KR')} · 펌웨어 ${r.fw_state} ${(r.fw_x10 / 10).toFixed(1)} mA, 출력 ${r.fw_sec} s</div>`;
    } else {
      const v = r.values || {};
      body += i.fields.map(f => inputRow(f[0], f[1], f[2], v[f[0]])).join('');
      const acts = [];
      if (i.startX10) acts.push(`<button data-do="start" ${cmdChar ? '' : 'disabled'}>START ${(i.startX10 / 10).toFixed(1)} mA</button>`);
      acts.push(r.done ? '<button data-do="undo" class="ghost">되돌리기</button>' : '<button data-do="done" class="primary">기록 완료</button>');
      body += `<div class="acts">${acts.join('')}</div>`;
    }
    return `<div class="item${isCur ? ' cur' : ''}${r.done ? ' done' : ''}${open ? '' : ' compact'}" data-id="${i.id}">
      <div class="item-head" data-do="toggle"><b>${i.kind === 'cap' ? i.id + '.csv' : i.title}</b>${tag}</div>
      <div class="body">${body}</div></div>`;
  }).join('') || '<p class="muted">남은 항목이 없습니다. 기록·내보내기 탭에서 CSV를 내려받으세요.</p>';
}

function itemInputs(el) {
  const v = {};
  $$('input[data-k]', el).forEach(x => { v[x.dataset.k] = x.value === '' ? null : x.type === 'number' ? Number(x.value) : x.value.trim(); });
  return v;
}

function onRunClick(e) {
  const btn = e.target.closest('[data-do]'); if (!btn) return;
  const el = btn.closest('.item'); const i = PLAN.find(x => x.id === el.dataset.id);
  const act = btn.dataset.do;
  if (act === 'toggle') { openItems.has(i.id) ? openItems.delete(i.id) : openItems.add(i.id); renderRun(); return; }
  if (act === 'start') { startAt(i.kind === 'cap' ? i.x10 : i.startX10); return; }
  if (act === 'undo') { if (db.run[i.id]) db.run[i.id].done = false; save(); renderRun(); return; }
  if (act === 'done') {
    const v = itemInputs(el);
    if (i.kind === 'cap') {
      const w = liveCheck(i);
      if (!v.scope && !confirm('Scope 파일 이름이 비어 있습니다. 그래도 기록할까요?')) return;
      if (i.restart === 'power' && v.vbat == null && !confirm('V_bat이 비어 있습니다. 그래도 기록할까요?')) return;
      if (w.length && !confirm('확인 필요: ' + w.join(' ') + '\n그래도 기록할까요?')) return;
      db.run[i.id] = Object.assign({}, v, { done: true, time: new Date().toISOString(), fw_state: live.state || '-', fw_x10: live.x10, fw_sec: live.sec });
    } else {
      db.run[i.id] = { done: true, time: new Date().toISOString(), values: v };
    }
    openItems.delete(i.id);
    save(); renderRun(); renderLive();
  }
}

function onRunChange(e) {
  const el = e.target.closest('.item'); if (!el || !e.target.dataset.k) return;
  const r = db.run[el.dataset.id] = db.run[el.dataset.id] || {};
  const i = PLAN.find(x => x.id === el.dataset.id);
  const val = e.target.value === '' ? null : e.target.type === 'number' ? Number(e.target.value) : e.target.value.trim();
  if (i.kind === 'cap') r[e.target.dataset.k] = val; else { r.values = r.values || {}; r.values[e.target.dataset.k] = val; }
  save();
}

/* ---------- R_L table ---------- */
function renderRL() {
  $('#rlList').innerHTML = LOADS.map(([k, nom]) => inputRow(k, `R_L ${k}`, `공칭 ${nom} Ω`, db.rl[k])).join('');
}

/* ---------- export ---------- */
const esc = x => { const s = x == null ? '' : String(x); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

function runCSV() {
  const head = ['file', 'measurement', 'I_set_mA', 'R_L_nominal', 'R_L_nominal_ohm', 'R_L_ohm', 'run', 'orientation', 'restart', 'wait_s',
    'f_set_Hz', 'phase_us', 'V_bat_V', 'scope_file', 'fw_state', 'fw_current_mA', 'fw_output_s', 'captured_at', 'note', 'data_type'];
  const rows = CAPS.map(i => {
    const r = db.run[i.id] || {};
    return [i.id + '.csv', i.meas, i.x10 / 10, i.rl, RL_NOM[i.rl], db.rl[i.rl], i.run, i.orient, i.restart, i.wait, 1000, 250,
      r.vbat, r.scope, r.done ? r.fw_state : '', r.done ? r.fw_x10 / 10 : '', r.done ? r.fw_sec : '', r.done ? r.time : '', r.note, r.done ? 'MEASURED' : 'TODO'].map(esc).join(',');
  });
  return [head.join(','), ...rows].join('\n');
}

function benchCSV() {
  const out = ['section,item,key,value'];
  TESTS.forEach(t => {
    const s = db.tests[t.id] || {};
    out.push(['bench_test', t.id, 'passed', s.done ? 'yes' : 'no'].map(esc).join(','));
    Object.entries(s.values || {}).forEach(([k, v]) => out.push(['bench_test', t.id, k, v].map(esc).join(',')));
  });
  PLAN.filter(i => i.kind === 'manual').forEach(i => {
    const v = (db.run[i.id] || {}).values || {};
    Object.entries(v).forEach(([k, x]) => out.push([i.meas, i.id, k, x].map(esc).join(',')));
  });
  LOADS.forEach(([k]) => out.push(['R_L', k, 'R_L_ohm', db.rl[k]].map(esc).join(',')));
  return out.join('\n');
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- wiring ---------- */
function showTab(t) {
  tab = t;
  $$('#tabs button').forEach(b => b.classList.toggle('sel', b.dataset.tab === t));
  $$('section.tab').forEach(s => { s.hidden = s.dataset.tab !== t; });
  if (t === 'run') renderRun();
  renderLive();
}

document.addEventListener('DOMContentLoaded', () => {
  $('#connectBtn').addEventListener('click', connect);
  $('#disconnectBtn').addEventListener('click', async () => { await send('0'); try { device && device.gatt.disconnect(); } catch (e) {} });
  $('#stopBtn').addEventListener('click', () => send('0'));
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });
  $('#currentChips').addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.disabled) send(b.dataset.cmd); });
  $('#pulseBtn').addEventListener('click', () => send('p'));

  $('#testList').addEventListener('click', onTestEvent);
  $('#testList').addEventListener('change', onTestEvent);
  $('#runList').addEventListener('click', onRunClick);
  $('#runList').addEventListener('change', onRunChange);
  $('#runFilter').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    runFilter = b.dataset.f;
    $$('#runFilter button').forEach(x => x.classList.toggle('sel', x === b));
    renderRun();
  });
  $('#rlList').addEventListener('change', e => {
    if (!e.target.dataset.k) return;
    db.rl[e.target.dataset.k] = e.target.value === '' ? null : Number(e.target.value);
    save(); renderRun();
  });

  const stamp = () => new Date().toISOString().slice(0, 10);
  $('#csvBtn').addEventListener('click', () => {
    download(`run_log_measured_${stamp()}.csv`, runCSV());
    setTimeout(() => download(`bench_values_${stamp()}.csv`, benchCSV()), 600);
  });
  $('#copyBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(runCSV() + '\n\n' + benchCSV()); notice('기록을 복사했습니다.'); }
    catch (e) { notice('복사 실패: ' + e.message, true); }
  });
  $('#clearBtn').addEventListener('click', () => {
    if (!confirm('bench test, 측정 기록, R_L 값을 모두 지울까요? (먼저 CSV를 내려받으세요)')) return;
    db = blank(); save(); renderTests(); renderRun(); renderRL(); notice('초기화했습니다.');
  });

  setConnected(false);
  renderRL();
  showTab('ctl');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
});
