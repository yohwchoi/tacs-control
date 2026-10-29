/*
 * tES experiment firmware v1  (2026-10-29)  -- APCMBE poster measurements M1-M4
 * Bench test only. Load = resistor R_L between the electrode outputs. No person/animal.
 *
 * Board : XIAO nRF52840 (No Updates), Seeed mbed-enabled Boards 2.9.3
 * Lib   : ArduinoBLE 2.1.0
 * App   : https://yohwchoi.github.io/tacs-control/exp.html  (Experiment app v1)
 *         The diagnostic app (index.html) also works: same BLE service and commands.
 *         Serial Monitor (115200) accepts the same letters while USB is attached.
 *
 * Superset of tES-DIAG v2. New:
 *   'p'  PULSE  1 kHz symmetric biphasic, generated in hardware (TIMER3 + PPI + GPIOTE),
 *               so BLE activity cannot disturb the phase timing.
 *   'n'  1.5 mA target (with 'l' 0.5, 'm' 1.0, 'h' 2.0)
 *   PWM reference = true 12-bit: PWM2 peripheral driven directly at 16 MHz, COUNTERTOP 4096
 *               (3.9 kHz, ripple after the 20k/10uF RC ~0.1 %). I = V_ref / 470 ohm.
 *               (mbed PwmOut counts in 1 us steps: DIAG v2 at 50 us had only 50 levels,
 *                so 1 mA came out ~1.7 % low. Not used here.)
 *
 * One period (1000 us), repeating; the timer starts at t = 0 in REST:
 *     t =   0 .. 500 us  REST   SEL1=1 SEL2=0  (E+ and E- both on the rail -> 0 V across R_L)
 *     t = 500 .. 750 us  A (+)  SEL1=1 SEL2=1  (E+ rail, E- sink)
 *     t = 750 ..1000 us  B (-)  SEL1=0 SEL2=0  (E+ sink, E- rail)
 *   EN stays high for the whole PULSE state.
 *   TIMER3 compare events: CC0 = 500 us -> SET SEL2
 *                          CC1 = 750 us -> CLR SEL1 + CLR SEL2
 *                          CC2 =1000 us -> SET SEL1, timer clears (period restarts)
 *
 * Commands (one ASCII byte, BLE or Serial):
 *   '0' STOP   'r' REF only   'a' HOLD A   'b' HOLD B   's' SLOW (diagnostic, from DIAG v2)
 *   'p' PULSE  (1 s reference settling first, then biphasic output)
 *   'l' 'm' 'n' 'h'  target 0.5 / 1.0 / 1.5 / 2.0 mA (only while STOPPED)
 *   '?' resend status
 *
 * Status characteristic (notify, ASCII, <= 20 bytes), same format as DIAG v2:
 *   "<state>,<current x0.1 mA>,<seconds in state>,<slow info>,<stop reason>"
 *   state : 0 STOP, R REF, W settling, A, B, S slow, P pulse
 *   reason: U user, T timeout, F slow finished, D BLE disconnect, P power-on, - none
 *
 * Safety:
 *   - Boot = STOP. HOLD/REF auto-stop after 30 s, PULSE after 10 min. Current limited to 2 mA.
 *   - BLE disconnect = STOP. Unknown byte = STOP.
 *   - STOP opens the TMUX switches. It does NOT turn off the boost rail.
 *
 * Pins (same as DIAG v2): Reference PWM = D2, EN = D4, SEL1 = D5, SEL2 = D3
 *   (XIAO pin D2 is NOT diode D2 on the PCB.)
 *
 * Hardware resources: PWM2 (reference), TIMER3 + GPIOTE channels 6-7 + PPI channels 16-18 (PULSE).
 * (Chosen away from the ones mbed / the BLE stack normally use. The bench test checks this:
 *  the 1 kHz period must stay stable on the scope while the phone is connected.)
 */

#include <Arduino.h>
#include <ArduinoBLE.h>
#include <mbed.h>
#include <nrf.h>

#if !defined(ARDUINO_ARCH_MBED) || !defined(ARDUINO_SEEED_XIAO_NRF52840)
#error "Select XIAO nRF52840 (No Updates), Seeed mbed-enabled Boards 2.9.3."
#endif

constexpr pin_size_t PIN_REFERENCE = D2;
constexpr pin_size_t PIN_ENABLE    = D4;
constexpr pin_size_t PIN_SEL1      = D5;
constexpr pin_size_t PIN_SEL2      = D3;

constexpr float    LOGIC_HIGH_V    = 3.3f;
constexpr float    R_SENSE_OHM     = 470.0f;
constexpr uint16_t PWM_TOP         = 4096;    // 16 MHz / 4096 = 3.9 kHz, 12-bit duty
constexpr float    PWM_COUNTS      = 4096.0f;
#define REF_PWM NRF_PWM2
constexpr uint32_t SETTLE_MS       = 1000;    // RC reference settling before output
constexpr uint32_t HOLD_MAX_MS     = 30000;   // HOLD / REF auto-stop
constexpr uint32_t PULSE_MAX_MS    = 600000;  // PULSE auto-stop (10 min)
constexpr uint32_t SLOW_PHASE_MS   = 1000;
constexpr uint8_t  SLOW_CYCLES     = 5;
constexpr uint8_t  MAX_CURRENT_X10 = 20;      // 2.0 mA

// PULSE timing in 16 MHz ticks
constexpr uint32_t TICKS_PER_US = 16;
constexpr uint32_t T_A_START    = 500 * TICKS_PER_US;
constexpr uint32_t T_B_START    = 750 * TICKS_PER_US;
constexpr uint32_t T_PERIOD     = 1000 * TICKS_PER_US;

constexpr uint8_t GPIOTE_CH_SEL1 = 6;
constexpr uint8_t GPIOTE_CH_SEL2 = 7;
constexpr uint8_t PPI_CH_A       = 16;   // CC0 -> SET SEL2
constexpr uint8_t PPI_CH_B       = 17;   // CC1 -> CLR SEL1, fork CLR SEL2
constexpr uint8_t PPI_CH_REST    = 18;   // CC2 -> SET SEL1
#define PULSE_TIMER NRF_TIMER3

const char *FW_ID = "tES-EXP v1";

BLEService diagService("19b10000-e8f2-537e-4f6c-d104768a1214");
BLEByteCharacteristic cmdChar("19b10001-e8f2-537e-4f6c-d104768a1214", BLERead | BLEWrite);
BLEStringCharacteristic statusChar("19b10002-e8f2-537e-4f6c-d104768a1214", BLERead | BLENotify, 20);
BLEStringCharacteristic fwChar("19b10003-e8f2-537e-4f6c-d104768a1214", BLERead, 20);

enum class State { STOP, REF, SETTLING, HOLD_A, HOLD_B, SLOW, PULSE };

mbed::DigitalOut *enOut = nullptr;
mbed::DigitalOut *sel1Out = nullptr;
mbed::DigitalOut *sel2Out = nullptr;
static uint16_t refSeq[1] = { 0x8000 };   // EasyDMA buffer: bit15 = high first, so duty = code / 4096

State state = State::STOP;
State afterSettle = State::STOP;
uint8_t currentX10 = 10;           // 1.0 mA default
uint32_t stateStartMs = 0;
uint8_t slowPhase = 0;             // 0:A 1:off 2:B 3:off
uint8_t slowCycle = 0;
char stopReason = 'P';
bool bleReady = false;
bool wasConnected = false;
bool pulseRunning = false;
uint32_t lastStatusMs = 0;

float targetMA()  { return currentX10 / 10.0f; }
float refVolt()   { return targetMA() * 1e-3f * R_SENSE_OHM; }
uint32_t refCode() { return (uint32_t)(refVolt() / LOGIC_HIGH_V * PWM_COUNTS + 0.5f); }
float refDuty()   { return refCode() / PWM_COUNTS; }

uint32_t nrfPin(pin_size_t arduinoPin) { return (uint32_t)digitalPinToPinName(arduinoPin); }

/* ---------- 12-bit reference PWM (register level) ---------- */

void refInit() {
  pinMode(PIN_REFERENCE, OUTPUT);
  digitalWrite(PIN_REFERENCE, LOW);
  REF_PWM->ENABLE = 0;
  REF_PWM->PSEL.OUT[0] = nrfPin(PIN_REFERENCE);   // pin number incl. port bit, CONNECT = 0
  REF_PWM->PSEL.OUT[1] = 0xFFFFFFFFUL;
  REF_PWM->PSEL.OUT[2] = 0xFFFFFFFFUL;
  REF_PWM->PSEL.OUT[3] = 0xFFFFFFFFUL;
  REF_PWM->MODE = PWM_MODE_UPDOWN_Up;
  REF_PWM->PRESCALER = PWM_PRESCALER_PRESCALER_DIV_1;   // 16 MHz
  REF_PWM->COUNTERTOP = PWM_TOP;
  REF_PWM->LOOP = 0;
  REF_PWM->DECODER = (PWM_DECODER_LOAD_Common << PWM_DECODER_LOAD_Pos) |
                     (PWM_DECODER_MODE_RefreshCount << PWM_DECODER_MODE_Pos);
  REF_PWM->SEQ[0].PTR = (uint32_t)refSeq;
  REF_PWM->SEQ[0].CNT = 1;
  REF_PWM->SEQ[0].REFRESH = 0;
  REF_PWM->SEQ[0].ENDDELAY = 0;
  REF_PWM->SHORTS = 0;
  REF_PWM->ENABLE = 1;
}

// After a one-value sequence ends, the PWM keeps repeating the last value.
void refWriteCode(uint32_t code) {
  if (code > PWM_TOP) code = PWM_TOP;
  refSeq[0] = (uint16_t)(code | 0x8000);
  REF_PWM->EVENTS_SEQEND[0] = 0;
  REF_PWM->TASKS_SEQSTART[0] = 1;
}

char stateChar(State s) {
  switch (s) {
    case State::STOP:     return '0';
    case State::REF:      return 'R';
    case State::SETTLING: return 'W';
    case State::HOLD_A:   return 'A';
    case State::HOLD_B:   return 'B';
    case State::SLOW:     return 'S';
    case State::PULSE:    return 'P';
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

/* ---------- hardware biphasic generator ---------- */

uint32_t gpioteConfig(uint32_t pin, bool initHigh) {
  return (GPIOTE_CONFIG_MODE_Task << GPIOTE_CONFIG_MODE_Pos) |
         ((pin & 31UL) << GPIOTE_CONFIG_PSEL_Pos) |
         ((pin >> 5) << GPIOTE_CONFIG_PORT_Pos) |
         (GPIOTE_CONFIG_POLARITY_Toggle << GPIOTE_CONFIG_POLARITY_Pos) |
         ((initHigh ? 1UL : 0UL) << GPIOTE_CONFIG_OUTINIT_Pos);
}

void pulseStart() {
  // Ask for the crystal oscillator so the 1 kHz period is accurate (harmless if already on).
  NRF_CLOCK->TASKS_HFCLKSTART = 1;

  PULSE_TIMER->TASKS_STOP = 1;
  PULSE_TIMER->TASKS_CLEAR = 1;
  PULSE_TIMER->MODE = TIMER_MODE_MODE_Timer;
  PULSE_TIMER->BITMODE = TIMER_BITMODE_BITMODE_32Bit;
  PULSE_TIMER->PRESCALER = 0;                       // 16 MHz
  PULSE_TIMER->CC[0] = T_A_START;
  PULSE_TIMER->CC[1] = T_B_START;
  PULSE_TIMER->CC[2] = T_PERIOD;
  PULSE_TIMER->SHORTS = TIMER_SHORTS_COMPARE2_CLEAR_Msk;
  PULSE_TIMER->EVENTS_COMPARE[0] = 0;
  PULSE_TIMER->EVENTS_COMPARE[1] = 0;
  PULSE_TIMER->EVENTS_COMPARE[2] = 0;

  // REST levels first (SEL1=1, SEL2=0), then hand both pins to GPIOTE with the same levels.
  sel1Out->write(1);
  sel2Out->write(0);
  NRF_GPIOTE->CONFIG[GPIOTE_CH_SEL1] = gpioteConfig(nrfPin(PIN_SEL1), true);
  NRF_GPIOTE->CONFIG[GPIOTE_CH_SEL2] = gpioteConfig(nrfPin(PIN_SEL2), false);

  NRF_PPI->CH[PPI_CH_A].EEP    = (uint32_t)&PULSE_TIMER->EVENTS_COMPARE[0];
  NRF_PPI->CH[PPI_CH_A].TEP    = (uint32_t)&NRF_GPIOTE->TASKS_SET[GPIOTE_CH_SEL2];
  NRF_PPI->FORK[PPI_CH_A].TEP  = 0;
  NRF_PPI->CH[PPI_CH_B].EEP    = (uint32_t)&PULSE_TIMER->EVENTS_COMPARE[1];
  NRF_PPI->CH[PPI_CH_B].TEP    = (uint32_t)&NRF_GPIOTE->TASKS_CLR[GPIOTE_CH_SEL1];
  NRF_PPI->FORK[PPI_CH_B].TEP  = (uint32_t)&NRF_GPIOTE->TASKS_CLR[GPIOTE_CH_SEL2];
  NRF_PPI->CH[PPI_CH_REST].EEP   = (uint32_t)&PULSE_TIMER->EVENTS_COMPARE[2];
  NRF_PPI->CH[PPI_CH_REST].TEP   = (uint32_t)&NRF_GPIOTE->TASKS_SET[GPIOTE_CH_SEL1];
  NRF_PPI->FORK[PPI_CH_REST].TEP = 0;
  NRF_PPI->CHENSET = (1UL << PPI_CH_A) | (1UL << PPI_CH_B) | (1UL << PPI_CH_REST);

  enOut->write(1);                 // switches closed in REST: 0 V across R_L
  PULSE_TIMER->TASKS_START = 1;    // first + phase starts 500 us later
  pulseRunning = true;
}

void pulseStop() {
  enOut->write(0);                 // cut the output first
  if (!pulseRunning) return;
  PULSE_TIMER->TASKS_STOP = 1;
  PULSE_TIMER->TASKS_CLEAR = 1;
  NRF_PPI->CHENCLR = (1UL << PPI_CH_A) | (1UL << PPI_CH_B) | (1UL << PPI_CH_REST);
  sel1Out->write(0);
  sel2Out->write(0);
  NRF_GPIOTE->CONFIG[GPIOTE_CH_SEL1] = 0;   // pins go back to normal GPIO (now 0)
  NRF_GPIOTE->CONFIG[GPIOTE_CH_SEL2] = 0;
  pulseRunning = false;
}

/* ---------- static outputs (diagnostic) ---------- */

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
  pulseStop();
  enOut->write(0);
  sel1Out->write(0);
  sel2Out->write(0);
  refWriteCode(0);
  digitalWrite(LED_BUILTIN, HIGH);   // onboard LED off (active-low)
  state = State::STOP;
  stopReason = reason;
  stateStartMs = millis();
  sendStatus();
}

void startSettling(State next) {
  outputOff();
  refWriteCode(refCode());
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
  } else if (s == State::PULSE) {
    pulseStart();
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
  Serial.print("Target ");
  Serial.print(targetMA(), 1);
  Serial.print(" mA, PWM code ");
  Serial.print(refCode());
  Serial.print(" / 4096, V_ref ");
  Serial.print(refDuty() * LOGIC_HIGH_V, 4);
  Serial.println(" V");
  sendStatus();
}

void handleCommand(char c) {
  switch (c) {
    case '0':           stopAll('U'); break;
    case 'r': case 'R': stopAll('U'); startSettling(State::REF); break;
    case 'a': case 'A': stopAll('U'); startSettling(State::HOLD_A); break;
    case 'b': case 'B': stopAll('U'); startSettling(State::HOLD_B); break;
    case 's': case 'S': stopAll('U'); startSettling(State::SLOW); break;
    case 'p': case 'P': stopAll('U'); startSettling(State::PULSE); break;
    case 'l': case 'L': setCurrent(5); break;
    case 'm': case 'M': setCurrent(10); break;
    case 'n': case 'N': setCurrent(15); break;
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
  if (state == State::PULSE && elapsed >= PULSE_MAX_MS) {
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
  enOut = &hwEn;
  sel1Out = &hwSel1;
  sel2Out = &hwSel2;
  refInit();
  refWriteCode(0);

  digitalWrite(LED_BUILTIN, HIGH);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(115200);

  if (BLE.begin()) {
    BLE.setLocalName("PNU_tES_Exp");
    BLE.setDeviceName("PNU tES Experiment");
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
    Serial.println("\n=== tES-EXP v1 ===  bench only, resistor load");
    Serial.println(bleReady ? "BLE ready: PNU_tES_Exp" : "BLE init FAILED (Serial control only)");
    Serial.println("0 stop | p PULSE 1 kHz | l/m/n/h 0.5/1/1.5/2 mA | r ref | a/b hold | s slow | ? status");
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
