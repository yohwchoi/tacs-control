/*
 * tES PCB diagnostic firmware v2  (2026-10-29)
 * Bench test only. Load = indicator LEDs on the electrodes. No person/animal.
 *
 * Board : XIAO nRF52840 (No Updates), Seeed mbed-enabled Boards 2.9.3
 * Lib   : ArduinoBLE 2.1.0
 * App   : https://yohwchoi.github.io/tacs-control/  (Diagnostic app v3)
 *         Serial Monitor (115200) accepts the same letters while USB is attached.
 *
 * Every state HOLDS still so a DMM can read it.
 * Real current = (voltage at top of 470 ohm sense resistor) / 470 ohm.
 *
 * Commands (one ASCII byte, BLE or Serial):
 *   '0' STOP     EN low, reference 0
 *   'r' REF      reference on, EN low (output off)
 *   'a' HOLD A   SEL1=1, SEL2=1, EN high
 *   'b' HOLD B   SEL1=0, SEL2=0, EN high
 *   's' SLOW     A 1 s / off 1 s / B 1 s / off 1 s, 5 cycles
 *   'l' 'm' 'h'  target current 0.5 / 1.0 / 2.0 mA (only while STOPPED)
 *   '?'          resend status
 *
 * Status characteristic (notify, ASCII, <= 20 bytes):
 *   "<state>,<current x0.1 mA>,<seconds in state>,<slow info>,<stop reason>"
 *   state : 0 STOP, R REF, W settling, A, B, S slow
 *   slow  : cycle number + phase letter (A, B, o=off), "-" if not slow
 *   reason: U user, T 30 s timeout, F slow finished, D BLE disconnect, P power-on, - none
 *   example "A,10,12,-,-"  = HOLD A, 1.0 mA, 12 s
 *
 * Safety:
 *   - Boot = STOP. Holds auto-stop after 30 s. Current limited to 2 mA.
 *   - BLE disconnect = STOP.
 *   - STOP opens the TMUX switches. It does NOT turn off the boost rail
 *     (TPS61170 CTRL is tied to BAT+ in hardware).
 *
 * Pins: archived master PCB (same as tES_BLE_Output_LED_v1)
 *   Reference PWM = D2, EN = D4, SEL1 = D5, SEL2 = D3
 *   (XIAO pin D2 is NOT diode D2 on the PCB.)
 */

#include <Arduino.h>
#include <ArduinoBLE.h>
#include <mbed.h>

#if !defined(ARDUINO_ARCH_MBED) || !defined(ARDUINO_SEEED_XIAO_NRF52840)
#error "Select XIAO nRF52840 (No Updates), Seeed mbed-enabled Boards 2.9.3."
#endif

constexpr pin_size_t PIN_REFERENCE = D2;
constexpr pin_size_t PIN_ENABLE    = D4;
constexpr pin_size_t PIN_SEL1      = D5;
constexpr pin_size_t PIN_SEL2      = D3;

constexpr float LOGIC_HIGH_V    = 3.3f;
constexpr float R_SENSE_OHM     = 470.0f;
constexpr int   PWM_PERIOD_US   = 50;      // 20 kHz, filtered by on-board RC
constexpr uint32_t SETTLE_MS    = 1000;    // RC reference settling
constexpr uint32_t HOLD_MAX_MS  = 30000;   // auto-stop
constexpr uint32_t SLOW_PHASE_MS = 1000;
constexpr uint8_t  SLOW_CYCLES   = 5;
constexpr uint8_t  MAX_CURRENT_X10 = 20;   // 2.0 mA

const char *FW_ID = "tES-DIAG v2";

BLEService diagService("19b10000-e8f2-537e-4f6c-d104768a1214");
BLEByteCharacteristic cmdChar("19b10001-e8f2-537e-4f6c-d104768a1214", BLERead | BLEWrite);
BLEStringCharacteristic statusChar("19b10002-e8f2-537e-4f6c-d104768a1214", BLERead | BLENotify, 20);
BLEStringCharacteristic fwChar("19b10003-e8f2-537e-4f6c-d104768a1214", BLERead, 20);

enum class State { STOP, REF, SETTLING, HOLD_A, HOLD_B, SLOW };

mbed::DigitalOut *enOut = nullptr;
mbed::DigitalOut *sel1Out = nullptr;
mbed::DigitalOut *sel2Out = nullptr;
mbed::PwmOut *refOut = nullptr;

State state = State::STOP;
State afterSettle = State::STOP;
uint8_t currentX10 = 10;           // 1.0 mA default
uint32_t stateStartMs = 0;
uint8_t slowPhase = 0;             // 0:A 1:off 2:B 3:off
uint8_t slowCycle = 0;
char stopReason = 'P';
bool bleReady = false;
bool wasConnected = false;
uint32_t lastStatusMs = 0;

float targetMA() { return currentX10 / 10.0f; }
float refVolt()  { return targetMA() * 1e-3f * R_SENSE_OHM; }
float refDuty()  { return refVolt() / LOGIC_HIGH_V; }

char stateChar(State s) {
  switch (s) {
    case State::STOP:     return '0';
    case State::REF:      return 'R';
    case State::SETTLING: return 'W';
    case State::HOLD_A:   return 'A';
    case State::HOLD_B:   return 'B';
    case State::SLOW:     return 'S';
  }
  return '?';
}

void sendStatus() {
  char slow[6] = "-";
  if (state == State::SLOW) {
    const char ph = slowPhase == 0 ? 'A' : slowPhase == 2 ? 'B' : 'o';
    snprintf(slow, sizeof(slow), "%u%c", (unsigned)(slowCycle + 1), ph);
  }
  const unsigned sec = (unsigned)((millis() - stateStartMs) / 1000UL);
  char buf[24];
  snprintf(buf, sizeof(buf), "%c,%u,%u,%s,%c",
           stateChar(state), (unsigned)currentX10, sec, slow,
           state == State::STOP ? stopReason : '-');
  if (bleReady) statusChar.writeValue(buf);
  Serial.print("[status] ");
  Serial.println(buf);
  lastStatusMs = millis();
}

void outputOff() { enOut->write(0); }

void outputA() {
  enOut->write(0);
  sel1Out->write(1);
  sel2Out->write(1);
  enOut->write(1);
}

void outputB() {
  enOut->write(0);
  sel1Out->write(0);
  sel2Out->write(0);
  enOut->write(1);
}

void stopAll(char reason) {
  enOut->write(0);
  sel1Out->write(0);
  sel2Out->write(0);
  refOut->write(0.0f);
  digitalWrite(LED_BUILTIN, HIGH);   // onboard LED off (active-low)
  state = State::STOP;
  stopReason = reason;
  stateStartMs = millis();
  sendStatus();
}

void startSettling(State next) {
  outputOff();
  refOut->write(refDuty());
  afterSettle = next;
  state = State::SETTLING;
  stateStartMs = millis();
  sendStatus();
}

void enterState(State s) {
  state = s;
  stateStartMs = millis();
  if (s == State::HOLD_A) {
    outputA();
    digitalWrite(LED_BUILTIN, LOW);
  } else if (s == State::HOLD_B) {
    outputB();
    digitalWrite(LED_BUILTIN, LOW);
  } else if (s == State::SLOW) {
    slowPhase = 0;
    slowCycle = 0;
    outputA();
    digitalWrite(LED_BUILTIN, LOW);
  } else {
    outputOff();
  }
  sendStatus();
}

void setCurrent(uint8_t x10) {
  if (state != State::STOP) {
    Serial.println("Stop first, then change current.");
    sendStatus();
    return;
  }
  if (x10 > MAX_CURRENT_X10) x10 = MAX_CURRENT_X10;
  currentX10 = x10;
  sendStatus();
}

void handleCommand(char c) {
  switch (c) {
    case '0':           stopAll('U'); break;
    case 'r': case 'R': stopAll('U'); startSettling(State::REF); break;
    case 'a': case 'A': stopAll('U'); startSettling(State::HOLD_A); break;
    case 'b': case 'B': stopAll('U'); startSettling(State::HOLD_B); break;
    case 's': case 'S': stopAll('U'); startSettling(State::SLOW); break;
    case 'l': case 'L': setCurrent(5); break;
    case 'm': case 'M': setCurrent(10); break;
    case 'h': case 'H': setCurrent(20); break;
    case '?':           sendStatus(); break;
    case '\r': case '\n': case ' ': break;
    default:
      Serial.print("Unknown command: ");
      Serial.println((int)(uint8_t)c);
      stopAll('U');    // unknown byte -> safe state
      break;
  }
}

void updateState() {
  const uint32_t elapsed = millis() - stateStartMs;

  if (state == State::SETTLING && elapsed >= SETTLE_MS) {
    enterState(afterSettle);
    return;
  }
  if ((state == State::HOLD_A || state == State::HOLD_B || state == State::REF) &&
      elapsed >= HOLD_MAX_MS) {
    stopAll('T');
    return;
  }
  if (state == State::SLOW && elapsed >= SLOW_PHASE_MS) {
    stateStartMs = millis();
    slowPhase = (slowPhase + 1) & 3;
    if (slowPhase == 0) {
      slowCycle++;
      if (slowCycle >= SLOW_CYCLES) {
        stopAll('F');
        return;
      }
    }
    if (slowPhase == 0)      outputA();
    else if (slowPhase == 2) outputB();
    else                     outputOff();
    sendStatus();
    return;
  }
  // Periodic status while active so the app can show elapsed time.
  if (state != State::STOP && millis() - lastStatusMs >= 1000) sendStatus();
}

void setup() {
  static mbed::DigitalOut hwEn(digitalPinToPinName(PIN_ENABLE), 0);
  static mbed::DigitalOut hwSel1(digitalPinToPinName(PIN_SEL1), 0);
  static mbed::DigitalOut hwSel2(digitalPinToPinName(PIN_SEL2), 0);
  static mbed::PwmOut hwRef(digitalPinToPinName(PIN_REFERENCE));
  enOut = &hwEn;
  sel1Out = &hwSel1;
  sel2Out = &hwSel2;
  refOut = &hwRef;
  refOut->period_us(PWM_PERIOD_US);
  refOut->write(0.0f);

  digitalWrite(LED_BUILTIN, HIGH);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(115200);

  if (BLE.begin()) {
    BLE.setLocalName("PNU_tES_Diag");
    BLE.setDeviceName("PNU tES Diagnostic");
    BLE.setAdvertisedService(diagService);
    diagService.addCharacteristic(cmdChar);
    diagService.addCharacteristic(statusChar);
    diagService.addCharacteristic(fwChar);
    BLE.addService(diagService);
    fwChar.writeValue(FW_ID);
    cmdChar.writeValue(static_cast<uint8_t>('0'));
    BLE.advertise();
    bleReady = true;
  }
  stopAll('P');
}

void loop() {
  static bool serialWasOpen = false;
  const bool serialOpen = static_cast<bool>(Serial);
  if (serialOpen && !serialWasOpen) {
    Serial.println("\n=== tES-DIAG v2 ===  bench only, LEDs on electrodes");
    Serial.println(bleReady ? "BLE ready: PNU_tES_Diag" : "BLE init FAILED (Serial control only)");
    Serial.println("0 stop | r ref | a hold A | b hold B | s slow | l/m/h 0.5/1/2 mA | ? status");
    sendStatus();
  }
  serialWasOpen = serialOpen;

  while (Serial.available() > 0) handleCommand(static_cast<char>(Serial.read()));

  if (bleReady) {
    BLE.poll();
    BLEDevice central = BLE.central();
    const bool connected = central && central.connected();
    if (connected && !wasConnected) {
      stopAll('U');
      Serial.println("Phone connected.");
    } else if (!connected && wasConnected) {
      stopAll('D');
      Serial.println("Phone disconnected -> STOP.");
      BLE.advertise();
    }
    wasConnected = connected;
    if (connected && cmdChar.written()) handleCommand(static_cast<char>(cmdChar.value()));
  }

  updateState();
  delay(1);
}
