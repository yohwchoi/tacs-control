'use strict';
/* tES PCB diagnostic app v3 — pairs with firmware tES-DIAG v2. */

const SVC = '19b10000-e8f2-537e-4f6c-d104768a1214';
const CMD = '19b10001-e8f2-537e-4f6c-d104768a1214';
const STATUS = '19b10002-e8f2-537e-4f6c-d104768a1214';
const FW = '19b10003-e8f2-537e-4f6c-d104768a1214';
const R_SENSE = 470;
const HOLD_MAX_S = 30;
const STORE_KEY = 'tes-diag-records-v1';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

let device = null, cmdChar = null, statusChar = null;
let writeQueue = Promise.resolve();
let live = { state: null, x10: 10, sec: 0, slow: '-', reason: '-' };
let selectedX10 = 10;
let pcb = null, power = null;
let records = loadRecords();
let boostOk = null;  // result of step 1

const STATE_TEXT = { '0': 'STOP', R: 'REF only', W: 'Settling…', A: 'HOLD A', B: 'HOLD B', S: 'SLOW' };
const REASON_TEXT = { U: '사용자', T: '30초 자동 정지', F: 'SLOW 완료', D: '연결 끊김', P: '전원 켜짐', '-': '' };
const STEP_FOR_STATE = { '0': '1', R: '2', A: '3', B: '4', S: '5' };

/* ---------- BLE ---------- */
function notice(text, bad = false) {
  const n = $('#notice');
  if (!text) { n.hidden = true; return; }
  n.textContent = text; n.className = 'notice' + (bad ? ' bad' : ''); n.hidden = false;
}

async function connect() {
  if (!navigator.bluetooth) {
    notice('이 브라우저는 Bluetooth를 지원하지 않습니다. Android Chrome에서 여세요.', true);
    return;
  }
  try {
    notice('');
    setBadge('busy', '연결 중…');
    device = await navigator.bluetooth.requestDevice({ filters: [{ services: [SVC] }] });
    device.addEventListener('gattserverdisconnected', onDisconnected);
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService(SVC);
    cmdChar = await svc.getCharacteristic(CMD);
    try {
      statusChar = await svc.getCharacteristic(STATUS);
    } catch (e) {
      throw new Error('FW_MISMATCH');
    }
    try {
      const fw = await (await svc.getCharacteristic(FW)).readValue();
      $('#fwId').textContent = new TextDecoder().decode(fw);
    } catch (e) { $('#fwId').textContent = '?'; }
    statusChar.addEventListener('characteristicvaluechanged', ev => parseStatus(ev.target.value));
    await statusChar.startNotifications();
    parseStatus(await statusChar.readValue());
    setConnected(true);
  } catch (e) {
    setConnected(false);
    if (e.message === 'FW_MISMATCH') {
      notice('보드에 진단 펌웨어(tES-DIAG v2)가 없습니다. tES_Diag_v2.ino를 업로드하세요.', true);
      try { device.gatt.disconnect(); } catch (_) {}
    } else if (e.name === 'NotFoundError') {
      notice('기기 선택이 취소되었습니다.');
    } else {
      notice('연결 실패: ' + e.message, true);
    }
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

function parseStatus(dv) {
  const t = new TextDecoder().decode(dv).trim();
  const [st, x10, sec, slow, reason] = t.split(',');
  live = { state: st, x10: Number(x10) || 0, sec: Number(sec) || 0, slow: slow || '-', reason: reason || '-' };
  selectedX10 = live.x10;
  renderLive();
}

/* ---------- UI: live ---------- */
function setBadge(cls, text) { const b = $('#connBadge'); b.className = 'badge ' + cls; b.textContent = text; }

function setConnected(on) {
  if (!on) { cmdChar = null; statusChar = null; live.state = null; }
  setBadge(on ? 'on' : 'off', on ? '연결됨' : '연결 안 됨');
  $('#connectBtn').hidden = on;
  $('#disconnectBtn').hidden = !on;
  $('#live').hidden = !on;
  $('#stopBtn').disabled = !on;
  $$('.step .go').forEach(b => { b.disabled = !on; });
  renderLive();
}

function renderLive() {
  const s = live.state;
  $('#liveState').textContent = s == null ? '-' :
    (STATE_TEXT[s] || s) + (s === 'S' && live.slow !== '-' ? ` (${live.slow})` : '') +
    (s === '0' && REASON_TEXT[live.reason] ? ` · ${REASON_TEXT[live.reason]}` : '');
  $('#liveCurrent').textContent = (live.x10 / 10).toFixed(1) + ' mA';
  const holding = s === 'A' || s === 'B' || s === 'R';
  $('#liveTime').textContent = s == null ? '-' : holding ? `${live.sec} s (남은 ${Math.max(0, HOLD_MAX_S - live.sec)} s)` : `${live.sec} s`;

  $$('#currentChips button').forEach(b => {
    b.classList.toggle('sel', Number(b.dataset.x10) === selectedX10);
    b.disabled = !cmdChar || s !== '0';
  });
  const activeStep = STEP_FOR_STATE[s];
  $$('.step').forEach(card => {
    const go = $('.go', card);
    const on = card.dataset.step === activeStep && s !== '0';
    go.classList.toggle('active', on || (card.dataset.step === '1' && s === '0'));
  });
  const exp = expectedV();
  $$('.expRef').forEach(e => { e.textContent = exp.toFixed(3) + ' V'; });
  $$('.step').forEach(updateVerdict);
}

const expectedV = () => selectedX10 / 10 * 1e-3 * R_SENSE;

/* ---------- Steps ---------- */
function stepValues(card) {
  const v = {};
  $$('input[data-k]', card).forEach(i => { if (i.value !== '') v[i.dataset.k] = Number(i.value); });
  $$('.yn', card).forEach(g => { const s = $('button.sel', g); if (s) v[g.dataset.k] = s.dataset.v; });
  return v;
}

function judge(step, v) {
  const exp = expectedV();
  if (step === '1') {
    if (v.vbat == null || v.vout == null) return null;
    const lift = v.vout - v.vbat;
    if (v.vbat < 3.3) return ['warn', `BAT+가 ${v.vbat} V로 낮습니다. battery 충전 상태나 BAT+ 경로를 먼저 확인하세요.`];
    if (lift >= 1.0) return ['ok', `승압 확인: Boost out이 BAT+보다 ${lift.toFixed(2)} V 높습니다. Step 2로.`];
    return ['bad', `승압 없음 (차이 ${lift.toFixed(2)} V). Boost converter가 스위칭하지 않습니다. LED 테스트보다 U1 pin 측정(VIN·CTRL·GND·FB)이 먼저입니다.`];
  }
  if (step === '2') {
    if (v.vref == null) return null;
    const err = (v.vref - exp) / exp;
    if (Math.abs(err) <= 0.15) return ['ok', `Reference 정상 (기대 ${exp.toFixed(3)} V, 오차 ${(err * 100).toFixed(0)}%).`];
    if (v.vref < 0.05) return ['bad', 'Reference가 거의 0 V입니다. XIAO D2 pin → RC filter 연결이나 pin mapping을 확인하세요.'];
    return ['warn', `Reference가 기대값과 다릅니다 (오차 ${(err * 100).toFixed(0)}%). RC 부품 값이나 PWM 설정을 확인하세요.`];
  }
  if (step === '3' || step === '4') {
    if (v.vsense == null && v.led == null) return null;
    const iMA = v.vsense != null ? v.vsense / R_SENSE * 1000 : null;
    const target = selectedX10 / 10;
    const iTxt = iMA != null ? `실제 current ${iMA.toFixed(2)} mA (목표 ${target.toFixed(1)} mA). ` : '';
    const iOk = iMA != null && Math.abs(iMA - target) / target <= 0.2;
    const iZero = iMA != null && iMA < 0.05 * target;
    if (iOk && v.led === 'yes') return ['ok', iTxt + '이 방향 정상.'];
    if (iOk && v.led === 'no') return ['warn', iTxt + 'current는 흐르는데 LED가 꺼져 있습니다. LED 방향이나 전극 접촉, 다른 경로로 새는지 확인하세요.'];
    if (iZero) return ['bad', iTxt + 'current가 흐르지 않습니다. 경로가 끊겼거나 전압이 부족합니다: TMUX supply, TMUX EN/SEL pin, MOSFET, 전극 연결 순으로 확인.'];
    if (iMA != null && !iOk) return ['warn', iTxt + 'current가 목표와 다릅니다. Boost out이 출력 중에 처지는지(compliance 부족) 확인하세요.'];
    return v.led === 'yes' ? ['ok', 'LED 켜짐. V_sense를 입력하면 실제 current를 계산합니다.'] : ['warn', 'LED 꺼짐. V_sense를 입력하면 원인을 좁힐 수 있습니다.'];
  }
  if (step === '5') {
    if (v.ledA == null || v.ledB == null) return null;
    if (v.ledA === 'yes' && v.ledB === 'yes') return ['ok', '양방향 switching 정상.'];
    if (v.ledA !== v.ledB) return ['warn', '한 방향만 동작합니다. 안 되는 방향의 TMUX 채널·SEL pin을 확인하세요.'];
    return ['bad', '양쪽 모두 안 켜집니다. Step 3/4 결과를 먼저 보세요.'];
  }
  return null;
}

function updateVerdict(card) {
  const step = card.dataset.step;
  const r = judge(step, stepValues(card));
  const box = $('.verdict', card);
  if (!r) { box.hidden = true; } else { box.className = 'verdict ' + r[0]; box.textContent = r[1]; box.hidden = false; }
  if (step === '1') {
    boostOk = r ? r[0] === 'ok' : null;
    $$('.boostWarn').forEach(w => { w.hidden = boostOk !== false; });
  }
  return r;
}

/* ---------- Records ---------- */
function loadRecords() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch (e) { return []; }
}
function saveRecords() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(records)); } catch (e) {}
}
const STEP_NAME = { '1': 'Baseline', '2': 'REF', '3': 'HOLD A', '4': 'HOLD B', '5': 'SLOW' };

function addRecord(card) {
  const step = card.dataset.step;
  const v = stepValues(card);
  if (!Object.keys(v).length) { notice('저장할 측정값이 없습니다.'); return; }
  const r = judge(step, v);
  const rec = {
    time: new Date().toISOString(),
    pcb: pcb || '?', power: power || '?', step: STEP_NAME[step],
    target_mA: selectedX10 / 10, fw: $('#fwId').textContent,
    values: v, verdict: r ? r[1] : ''
  };
  if (v.vsense != null) rec.values.i_mA = +(v.vsense / R_SENSE * 1000).toFixed(3);
  records.push(rec);
  saveRecords();
  renderRecords();
  notice(`${STEP_NAME[step]} 기록 저장됨.`);
}

function recLine(r) {
  const vals = Object.entries(r.values).map(([k, x]) => `${k}=${x}`).join(' ');
  const t = new Date(r.time);
  const hm = t.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return { hm, text: `${r.pcb} · ${r.power} · ${r.step} · ${r.target_mA} mA · ${vals}` };
}

function renderRecords() {
  const box = $('#records');
  $('#recCount').textContent = records.length + '건';
  if (!records.length) { box.innerHTML = '<p class="muted">아직 기록이 없습니다.</p>'; return; }
  box.innerHTML = '';
  records.slice().reverse().forEach(r => {
    const { hm, text } = recLine(r);
    const d = document.createElement('div');
    d.className = 'rec';
    const m1 = document.createElement('div'); m1.className = 'meta'; m1.textContent = hm;
    const b = document.createElement('b'); b.textContent = text;
    const m2 = document.createElement('div'); m2.className = 'meta'; m2.textContent = r.verdict;
    d.append(m1, b, m2);
    box.appendChild(d);
  });
}

function recordsText() {
  return records.map(r => { const { text } = recLine(r); return `${r.time}\t${text}\t${r.verdict}`; }).join('\n');
}

function recordsCSV() {
  const keys = ['vbat', 'vout', 'vtmux', 'vref', 'vsense', 'i_mA', 'vouthold', 'led', 'ledA', 'ledB'];
  const head = ['time', 'pcb', 'power', 'step', 'target_mA', 'fw', ...keys, 'verdict'];
  const esc = x => { const s = x == null ? '' : String(x); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = records.map(r => [r.time, r.pcb, r.power, r.step, r.target_mA, r.fw, ...keys.map(k => r.values[k]), r.verdict].map(esc).join(','));
  return [head.join(','), ...rows].join('\n');
}

/* ---------- Wiring ---------- */
function chipGroup(el, onPick) {
  el.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    $$('button', el).forEach(x => x.classList.toggle('sel', x === b));
    onPick(b);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  $('#connectBtn').addEventListener('click', connect);
  $('#disconnectBtn').addEventListener('click', async () => {
    await send('0');
    try { device && device.gatt.disconnect(); } catch (e) {}
  });
  $('#stopBtn').addEventListener('click', () => send('0'));

  chipGroup($('#pcbChips'), b => { pcb = b.dataset.v; });
  chipGroup($('#powerChips'), b => { power = b.dataset.v; });
  $('#currentChips').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    send(b.dataset.cmd);
  });

  $$('.step').forEach(card => {
    $('.go', card).addEventListener('click', () => send(card.dataset.cmd));
    $$('input', card).forEach(i => i.addEventListener('input', () => updateVerdict(card)));
    $$('.yn', card).forEach(g => chipGroup(g, () => updateVerdict(card)));
    $('.save', card).addEventListener('click', () => addRecord(card));
  });

  $('#copyBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(recordsText()); notice('기록을 복사했습니다.'); }
    catch (e) { notice('복사 실패: ' + e.message, true); }
  });
  $('#csvBtn').addEventListener('click', () => {
    const blob = new Blob(['﻿' + recordsCSV()], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tES_diag_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#clearBtn').addEventListener('click', () => {
    if (!records.length || !confirm('측정 기록을 모두 지울까요?')) return;
    records = []; saveRecords(); renderRecords(); notice('기록을 지웠습니다.');
  });

  setConnected(false);
  renderRecords();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
});
