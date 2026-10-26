'use strict';
// Preserve the firmware's legacy device name, UUIDs and one-byte command protocol.
const PROTOCOL = Object.freeze({
  name: 'PNU_tACS_Sense',
  service: '19b10000-e8f2-537e-4f6c-d104768a1214',
  mode: '19b10001-e8f2-537e-4f6c-d104768a1214',
  boostService: '19b10020-e8f2-537e-4f6c-d104768a1214',
  boost: '19b10021-e8f2-537e-4f6c-d104768a1214'
});
const VOLTAGES = ['3.70 (Off)', '3.70', '3.70', '3.70', '3.70', '5.23', '6.32', '7.41', '8.50', '9.59', '10.68', '11.77', '12.86', '13.95', '15.04', '16.13', '21.05', '22.14', '23.23', '24.32', '25.41', '26.50', '27.59', '28.68', '29.77', '30.86', '31.95', '33.04', '34.13', '34.41', '34.41', '34.41'];
const $ = id => document.getElementById(id);
let device = null, modeChar = null, boostChar = null;
let connecting = false, busy = false, stopPending = false, selectedMode = null, session = 0;
let installPrompt = null, waitingWorker = null;

function notice(title, text, error = null, info = false) {
  $('notice').hidden = false;
  $('notice').classList.toggle('info', info);
  $('noticeTitle').textContent = title;
  $('noticeText').textContent = text;
  $('errorDetails').hidden = !error;
  $('errorTechnical').textContent = error ? `${error.name || 'Error'}: ${error.message || String(error)}` : '';
}
function supported() { return window.isSecureContext && Boolean(navigator.bluetooth); }
function connected() { return Boolean(device?.gatt.connected && modeChar); }
function render() {
  const ready = connected();
  $('connectionState').textContent = connecting ? 'Connecting…' : ready ? 'Connected' : 'Not connected';
  $('connectionBadge').classList.toggle('connected', ready);
  $('connectionBadge').classList.toggle('pending', connecting);
  $('connectBtn').disabled = connecting || ready || !supported();
  $('connectBtn').textContent = connecting ? 'Connecting…' : ready ? 'XIAO connected' : 'Connect to XIAO ↗';
  $('connectionHint').textContent = ready ? 'Bluetooth is connected. Select a bench test below.' : 'Power your XIAO, turn on Bluetooth, then choose your device.';
  for (const id of ['ledBtn', 'stimBtn']) $(id).disabled = !ready || busy;
  $('boostModeBtn').disabled = !ready || busy || !boostChar;
  $('sendBtn').disabled = !ready || busy || !boostChar || selectedMode !== 3;
  $('stepInput').disabled = !ready || busy || !boostChar || selectedMode !== 3;
  $('stopBtn').disabled = !ready || stopPending;
  $('stopBtn').textContent = stopPending ? 'STOP QUEUED' : 'STOP ALL';
  $('stopHint').textContent = ready ? 'Sends stop; physical output is not monitored.' : 'Connect to send a stop command.';
  $('boostPanel').hidden = selectedMode !== 3 || !ready;
  ['ledBtn', 'stimBtn', 'boostModeBtn'].forEach((id, index) => {
    $(id).classList.toggle('selected', selectedMode === index + 1 && ready);
    $(id).setAttribute('aria-pressed', String(selectedMode === index + 1 && ready));
  });
  $('updateBtn').disabled = ready || connecting || busy;
}
function command(title, detail) {
  $('commandTitle').textContent = title;
  $('commandDetail').textContent = detail;
}
function friendlyError(error, stage) {
  if (stage === 'chooser' && error.name === 'NotFoundError') return ['No device selected', 'Pairing was cancelled or no matching device was found. Check that the board advertises PNU_tACS_Sense, then try again.'];
  if (error.name === 'NotFoundError' && stage === 'services') return ['Firmware service not found', 'The board is missing the expected tES service or control characteristic. Check the firmware before retrying.'];
  if (error.name === 'SecurityError' || error.name === 'NotAllowedError') return ['Bluetooth access blocked', 'Allow Bluetooth access for this site in Chrome. Open this controller directly in Android Chrome using HTTPS.'];
  if (error.name === 'NotSupportedError') return ['Bluetooth operation unsupported', 'Use current Android Chrome. If this happened after connecting, check that the board firmware supports writes with response.'];
  if (error.name === 'NetworkError') return ['Bluetooth connection interrupted', 'Keep the board nearby and powered, and close other apps connected to it. Reconnect and check the board before sending another command.'];
  if (error.name === 'InvalidStateError') return ['Device is not ready', 'The Bluetooth connection is unavailable. Reconnect to the board before trying again.'];
  return [stage === 'write' ? 'Command could not be confirmed' : 'Could not connect', 'Check board power, Bluetooth and the installed firmware, then retry. Technical details are available below.'];
}
function disconnected() {
  session += 1;
  modeChar = null; boostChar = null; connecting = false; busy = false; stopPending = false; selectedMode = null;
  $('stepReadout').textContent = 'No step sent this connection.';
  $('stepInput').value = '0';
  command('Connection lost.', 'No further commands can be sent. Device output is unknown; check the board before reconnecting.');
  notice('Bluetooth disconnected', 'The app cannot confirm that the hardware stopped. Check the board. Reconnecting will not restart a test.');
  render();
}
async function connect() {
  if (!supported() || connecting || connected()) return;
  connecting = true; $('notice').hidden = true; render();
  const attempt = ++session;
  let stage = 'chooser';
  try {
    if (device) device.removeEventListener('gattserverdisconnected', disconnected);
    device = await navigator.bluetooth.requestDevice({ filters: [{ name: PROTOCOL.name }], optionalServices: [PROTOCOL.service, PROTOCOL.boostService] });
    if (session !== attempt) return;
    device.addEventListener('gattserverdisconnected', disconnected);
    stage = 'connect';
    const server = await device.gatt.connect();
    stage = 'services';
    const service = await server.getPrimaryService(PROTOCOL.service);
    const discoveredMode = await service.getCharacteristic(PROTOCOL.mode);
    let discoveredBoost = null;
    try {
      const boostService = await server.getPrimaryService(PROTOCOL.boostService);
      discoveredBoost = await boostService.getCharacteristic(PROTOCOL.boost);
    } catch (error) {
      // Older two-mode firmware is still usable. Only a genuinely absent service is optional.
      if (error.name !== 'NotFoundError') throw error;
    }
    if (session !== attempt || !device.gatt.connected) return;
    modeChar = discoveredMode; boostChar = discoveredBoost;
    command('Connected. No test started.', 'Select an existing test mode. Connecting does not send a stimulation command.');
    if (!boostChar) notice('Basic controls available', 'This firmware does not expose the boost controls. LED, load-test and stop commands remain available.', null, true);
  } catch (error) {
    if (session === attempt) {
      if (device) device.removeEventListener('gattserverdisconnected', disconnected);
      if (device?.gatt.connected) device.gatt.disconnect();
      modeChar = null; boostChar = null;
      const [title, text] = friendlyError(error, stage);
      notice(title, text, error);
    }
  } finally {
    if (session === attempt) { connecting = false; render(); }
  }
}
async function operate(action) {
  if (!connected() || busy) return;
  const operationSession = session;
  busy = true; render();
  try { await action(operationSession); }
  catch (error) {
    if (session === operationSession) {
      const [title, text] = friendlyError(error, 'write');
      notice(title, text, error);
      command('Command unconfirmed.', 'Check the device before retrying. The app cannot determine its output.');
    }
  } finally {
    if (session === operationSession) {
      busy = false;
      if (stopPending && connected()) await performStop();
      render();
    }
  }
}
async function sendMode(value) {
  await operate(async operationSession => {
    await modeChar.writeValueWithResponse(Uint8Array.of(value));
    if (session !== operationSession) return;
    selectedMode = value;
    $('notice').hidden = true;
    const names = { 1: 'LED test', 2: '10 kΩ load test', 3: 'Boost-converter test' };
    command(`${names[value]} command sent.`, 'The board accepted the Bluetooth write. Physical output has not been measured by this app.');
  });
}
async function sendStep() {
  const raw = $('stepInput').value.trim();
  const step = Number(raw);
  if (raw === '' || !Number.isInteger(step) || step < 0 || step > 31) {
    notice('Choose a whole step from 0 to 31', 'No command was sent. Enter a valid hardware step.');
    return;
  }
  if (!boostChar || selectedMode !== 3) return;
  await operate(async operationSession => {
    await boostChar.writeValueWithResponse(Uint8Array.of(step));
    if (session !== operationSession) return;
    $('notice').hidden = true;
    $('stepReadout').textContent = `Sent step ${String(step).padStart(2, '0')} · Table: ${VOLTAGES[step]} V`;
    command(`Step ${String(step).padStart(2, '0')} command sent.`, 'The displayed voltage is a preset reference. Verify actual output with your bench equipment.');
  });
}
async function performStop() {
  const stopSession = session;
  const stopModeChar = modeChar, stopBoostChar = boostChar;
  busy = true; stopPending = true; render();
  // Attempt each stop write independently, including when the first one fails.
  const failures = [];
  try {
    try { await stopModeChar.writeValueWithResponse(Uint8Array.of(0)); } catch (error) { failures.push(error); }
    if (stopBoostChar && session === stopSession && connected()) {
      try { await stopBoostChar.writeValueWithResponse(Uint8Array.of(0)); } catch (error) { failures.push(error); }
    }
    if (session !== stopSession) return;
    selectedMode = null;
    if (failures.length) {
      notice('Stop could not be fully confirmed', 'Check the hardware output immediately. One or more stop writes failed; use the device controls if needed.', failures[0]);
      command('Stop unconfirmed.', 'The app cannot verify that the hardware stopped.');
    } else {
      $('notice').hidden = true;
      $('stepInput').value = '0';
      $('stepReadout').textContent = stopBoostChar ? 'Sent step 00 · Table: 3.70 (Off) V' : 'No boost service available.';
      command('Stop commands sent.', 'The board accepted the stop write(s). Verify that the physical output has stopped.');
    }
  } finally {
    if (session === stopSession) { busy = false; stopPending = false; render(); }
  }
}
async function requestStop() {
  if (!connected() || stopPending) return;
  stopPending = true;
  command('Sending stop…', busy ? 'Waiting for the current Bluetooth write to finish; stop is next.' : 'Sending the existing stop commands to the board.');
  render();
  if (!busy) await performStop();
}

$('connectBtn').addEventListener('click', connect);
$('ledBtn').addEventListener('click', () => sendMode(1));
$('stimBtn').addEventListener('click', () => sendMode(2));
$('boostModeBtn').addEventListener('click', () => sendMode(3));
$('sendBtn').addEventListener('click', sendStep);
$('stopBtn').addEventListener('click', requestStop);
VOLTAGES.forEach((voltage, index) => {
  const entry = document.createElement('span');
  entry.textContent = `${String(index).padStart(2, '0')} · ${voltage} V`;
  $('voltageTable').appendChild(entry);
});
if (!window.isSecureContext) notice('Open the secure app address', 'Bluetooth requires HTTPS. Use the published GitHub Pages address in Chrome.');
else if (!navigator.bluetooth) notice('Web Bluetooth is unavailable', 'Open this app directly in Android Chrome on a phone with Bluetooth support. An embedded browser may not support device pairing.');
render();

function installed() { return window.matchMedia('(display-mode: standalone)').matches; }
if (installed()) $('installHint').textContent = 'Installed. Open the tES Control icon from your home screen.';
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault(); installPrompt = event;
  $('installBtn').hidden = installed();
});
$('installBtn').addEventListener('click', async () => {
  if (!installPrompt) return;
  const prompt = installPrompt; installPrompt = null;
  $('installBtn').hidden = true;
  try {
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice.outcome !== 'accepted') $('installHint').textContent = 'Installation cancelled. You can install later from the Chrome menu.';
  } catch {
    $('installHint').textContent = 'Use Chrome’s ⋮ menu to install or add this controller to your home screen.';
  }
});
window.addEventListener('appinstalled', () => {
  $('installBtn').hidden = true;
  $('installHint').textContent = 'Installed. Look for tES Control on your home screen.';
});
function showUpdate(worker) {
  waitingWorker = worker; $('updateNotice').hidden = false; render();
}
let updating = false;
$('updateBtn').addEventListener('click', () => {
  if (connected() || connecting || busy || !waitingWorker) return;
  updating = true; waitingWorker.postMessage('ACTIVATE_UPDATE');
});
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (updating) window.location.reload(); });
  navigator.serviceWorker.register('./sw.js').then(registration => {
    navigator.serviceWorker.ready.then(() => { $('offlineStatus').textContent = 'App files saved for offline opening. Bluetooth pairing is still required.'; });
    if (registration.waiting) showUpdate(registration.waiting);
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdate(worker);
      });
    });
  }).catch(() => { $('offlineStatus').textContent = 'Offline access is unavailable. You can still use the app while online.'; });
} else $('offlineStatus').textContent = 'Offline saving is unavailable in this browser.';
