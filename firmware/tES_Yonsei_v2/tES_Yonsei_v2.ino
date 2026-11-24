/*
 * tES Yonsei firmware v2  (2026-11-24)  -- rat M1 stimulation at Yonsei, flat vs porous electrodes
 *
 * Board : XIAO nRF52840 (No Updates), Seeed mbed-enabled Boards 2.9.3
 * Lib   : ArduinoBLE 2.1.0
 * App   : https://yohwchoi.github.io/tacs-control/yonsei.html
 *
 * >>> Set BOARD_ID below before uploading to each board. <<<
 *
 * v2 (11/24 decision, Park 2024 / Prof. Jeong): 500 us anodic (+) + 500 us cathodic, no interphase gap,
 *   200 us rest -> period 1.2 ms (833 Hz); burst = 200 pulses (240 ms); 5 bursts per session;
 *   gap between bursts (end of one burst to start of the next) chosen in the app: 1, 3, 5, 7 or 9 s.
 *   Phase sweep keeps the period at 1.2 ms (only the rest gets longer), so the phase max is 500 us.
 *
 * Hardware change: jumper from the top of R_sense (MOSFET source side) to XIAO D0 (HAS_SENSE_JUMPER = true).
 *   Set R_SENSE_OHM to the resistor actually on the board (470 original, 220 after the swap). Before the jumper is soldered the check reads ~0 % (red light); output is unaffected.
 *   (Set it false to hide the check on a board that will never get the jumper.)
 *
 * Electrodes: E+ (TMUX D1) = stimulating electrode, E- (TMUX D2) = return (skull screw).
 *   SEL1=1 SEL2=1  A  anodic   (E+ rail, E- sink)
 *   SEL1=0 SEL2=0  C  cathodic (E+ sink, E- rail)
 *   SEL1=0 SEL2=1  REST        (E+ sink, E- sink: both near GND through the sink, 0 V between them)
 *   EN=0           OFF         (all switches open)
 *   v1 of the bench firmware rested with both electrodes on the +34 V rail. This version rests near GND.
 *
 * One pulse period (default 1200 us = 833 Hz, set per B command; LED test uses 3000 us), timer starts at t = 0 in REST:
 *   biphasic : CC0 = 20 us first phase | CC1 = 20+pw second phase (no gap) | CC2 = 20+2pw REST | CC3 = period, clear
 *              + first: A then C (default, as in Prof. Jeong's setup);  - first: C then A
 *   mono -   : CC0 cathodic start         | CC1 = 20+pw REST
 *   mono +   : CC0 anodic start           | CC1 = 20+pw REST
 *   The first phase edge also starts an SAADC sample of V_sense on D0 (40 us acquisition), so the
 *   current is measured in every pulse, inside the first phase.
 *   The pulse-end edge counts pulses in TIMER4; at the set count TIMER4 stops TIMER3 (in REST).
 *   All edges are hardware (TIMER3/TIMER4 + PPI + GPIOTE + SAADC), so BLE traffic cannot shift them.
 *
 * Commands (ASCII text, BLE write or Serial line):
 *   S or 0              STOP
 *   B<I>,<pw>,<n>[,<gap s>][,A|C]   (app, short: e.g. B30,500,5,3)   or   B<I>,<pw>,<n>,<period us>[,<gap ms>][,A|C]   (Serial)
 *                       n bursts of 200 biphasic pulses. I = mA x10 (5..30), pw = phase width us (50..1000),
 *                       period = pulse period in us (default 1200, max 100000; must be >= 2*pw + 70),
 *                       gap = ms from the end of a burst to the start of the next (500..30000, default 3000).
 *                       A = anodic (+) phase first (default), C = cathodic (-) first.
 *                       e.g. B30,500,5 = 3.0 mA, 500 us, 1.2 ms, 3 s gaps, + first;  B30,500,5,1200,7000,C = 7 s gaps, - first
 *   H+<I> / H-<I>       HOLD anodic / cathodic DC (max 30 s)
 *   L<I>,<pw>           LED test (LED jig only, never an animal): 167 cathodic-only pulses (0.5 s), then 167 anodic-only,
 *                       repeating (max 120 s). I up to 10.0 mA (L100,500), capped by the board: about 6 mA with 470 ohm,
 *                       10 mA with 220 ohm (reference limit 2.9 V on R_sense).
 *
 * Board LEDs: one short blink every 2 s while powered: blue = phone connected, green = waiting for the phone; red on = output running.
 *   ?                   send status now
 *   Start commands are accepted only when stopped. Anything else = STOP (reason E).
 *
 * Status (notify, ASCII, <= 20 bytes), every 200 ms while active and every 1 s when stopped:
 *   "<state>,<burst>,<pulse>,<pct>,<bat x100>,<reason>"
 *   state : 0 STOP, W settling (1 s), B burst, G gap between bursts, H hold, L LED
 *   burst : burst number 1..n (LED: 1 = cathodic half, 2 = anodic half)
 *   pulse : pulses done in this burst
 *   pct   : real current / set current in %, worst burst of this run ('-' = no measurement yet)
 *   bat   : battery voltage x100 (e.g. 392 = 3.92 V), read while no burst is running
 *   reason: when stopped U user, F finished, T timeout, D BLE disconnect, P power-on, E bad command; else -
 *
 * Safety: boot = STOP, BLE disconnect = STOP, max 3.0 mA, HOLD 30 s, LED 120 s, bad command = STOP.
 *   STOP opens the TMUX switches (EN=0). It does NOT turn off the boost rail.
 *
 * Pins: reference PWM = D2, EN = D4, SEL1 = D5, SEL2 = D3, V_sense = D0 (AIN0), battery = P0.31 (AIN7, enable P0.14 low)
 * Resources: PWM2, TIMER3, TIMER4, GPIOTE ch 6-7, PPI ch 16-19, SAADC (no analogRead() anywhere).
 */

#include <Arduino.h>
#include <ArduinoBLE.h>
#include <mbed.h>
#include <nrf.h>

#if !defined(ARDUINO_ARCH_MBED) || !defined(ARDUINO_SEEED_XIAO_NRF52840)
#error "Select XIAO nRF52840 (No Updates), Seeed mbed-enabled Boards 2.9.3."
#endif

/* ===== set per board ===== */
constexpr uint8_t BOARD_ID = 1;
constexpr float   R_SENSE_OHM = 470.0f;      // sense resistor on THIS board: 470 (original) or 220 (after the swap)
constexpr bool    HAS_SENSE_JUMPER = true;    // false only for a board without the R_sense -> D0 jumper (pct then always '-')
/* ========================= */

constexpr pin_size_t PIN_REFERENCE = D2;
constexpr pin_size_t PIN_ENABLE    = D4;
constexpr pin_size_t PIN_SEL1      = D5;
constexpr pin_size_t PIN_SEL2      = D3;

constexpr float    LOGIC_HIGH_V    = 3.3f;
constexpr uint16_t PWM_TOP         = 4096;
constexpr float    PWM_COUNTS      = 4096.0f;
#define REF_PWM NRF_PWM2

constexpr uint8_t  MIN_CURRENT_X10 = 5;
constexpr uint8_t  MAX_CURRENT_X10 = 30;      // 3.0 mA (B and H)
constexpr uint8_t  LED_REQ_MAX_X10 = 100;     // LED test may ask up to 10.0 mA
constexpr float    REF_MAX_V       = 2.9f;    // keep the reference below 3.3 V
constexpr uint8_t  LED_CAP_X10     = (REF_MAX_V / R_SENSE_OHM * 10000.0f) < 100.0f ? (uint8_t)(REF_MAX_V / R_SENSE_OHM * 10000.0f) : 100;
constexpr uint16_t MIN_PW_US       = 50;
constexpr uint16_t MAX_PW_US       = 1000;
constexpr uint8_t  MAX_BURSTS      = 10;
constexpr uint16_t PULSES_PER_BURST = 200;
constexpr uint16_t LED_HALF_PULSES = 167;     // 0.5 s at the LED period (3000 us)
constexpr uint32_t SETTLE_MS       = 1000;
constexpr uint32_t DEFAULT_GAP_MS  = 3000;
constexpr uint32_t MIN_GAP_MS      = 500;
constexpr uint32_t MAX_GAP_MS      = 30000;
constexpr uint32_t HOLD_MAX_MS     = 30000;
constexpr uint32_t LED_MAX_MS      = 120000;

constexpr uint32_t TICKS_PER_US = 16;
constexpr uint32_t T_LEAD_US    = 20;
constexpr uint32_t DEFAULT_PERIOD_US = 1200;   // 833 Hz (Park 2024: 500+500 us + 200 us rest)
constexpr uint32_t LED_PERIOD_US     = 3000;   // LED test blink timing (167 pulses = 0.5 s)
constexpr uint32_t MAX_PERIOD_US     = 100000;  // 10 Hz

constexpr uint8_t GPIOTE_CH_SEL1 = 6;
constexpr uint8_t GPIOTE_CH_SEL2 = 7;
constexpr uint8_t PPI_CH_0    = 16;   // CC0 -> first phase edge, fork SAADC sample
constexpr uint8_t PPI_CH_1    = 17;   // CC1 -> second edge (biphasic: anodic, both pins) / mono: REST + count
constexpr uint8_t PPI_CH_2    = 18;   // CC2 -> REST, fork count (biphasic only)
constexpr uint8_t PPI_CH_STOP = 19;   // TIMER4 CC0 (pulse count reached) -> TIMER3 STOP
constexpr uint32_t PPI_MASK = (1UL << PPI_CH_0) | (1UL << PPI_CH_1) | (1UL << PPI_CH_2) | (1UL << PPI_CH_STOP);
#define PULSE_TIMER NRF_TIMER3
#define COUNT_TIMER NRF_TIMER4

constexpr uint8_t SAADC_AIN_SENSE = SAADC_CH_PSELP_PSELP_AnalogInput0;   // D0 = P0.02
constexpr uint8_t SAADC_AIN_VBAT  = SAADC_CH_PSELP_PSELP_AnalogInput7;   // P0.31
constexpr uint8_t VBAT_ENABLE_PIN = 14;                                   // P0.14, low = divider on
constexpr float   VBAT_SCALE      = (1000.0f + 510.0f) / 510.0f;
constexpr float   SAADC_FULL_V    = 3.6f;                                 // internal 0.6 V ref, gain 1/6

char FW_ID[24];

BLEService ySvc("19b10100-e8f2-537e-4f6c-d104768a1214");
BLEStringCharacteristic cmdChar("19b10101-e8f2-537e-4f6c-d104768a1214", BLERead | BLEWrite, 20);
BLEStringCharacteristic statusChar("19b10102-e8f2-537e-4f6c-d104768a1214", BLERead | BLENotify, 20);
BLEStringCharacteristic fwChar("19b10103-e8f2-537e-4f6c-d104768a1214", BLERead, 24);

enum class State { STOP, SETTLING, BURST, GAP, HOLD, LED };
enum class Shape { BIPHASIC, BIPHASIC_A, MONO_CATH, MONO_ANOD };   // BIPHASIC = cathodic first, BIPHASIC_A = anodic first

mbed::DigitalOut *enOut = nullptr;
mbed::DigitalOut *sel1Out = nullptr;
mbed::DigitalOut *sel2Out = nullptr;
static uint16_t refSeq[1] = { 0x8000 };
static int16_t senseBuf[256];
static volatile int16_t oneSample;

State state = State::STOP;
State afterSettle = State::STOP;
uint8_t currentX10 = 10;
uint16_t pwUs = 500;
uint8_t nBursts = 5;
uint32_t periodUs = DEFAULT_PERIOD_US;
uint32_t gapMs = DEFAULT_GAP_MS;
bool anodicFirst = true;                     // B command order (11/24: + first, as in Prof. Jeong's MC_Stimulus setup)
bool holdAnodic = true;
uint8_t burstNo = 0;          // 1-based while running
uint32_t stateStartMs = 0;
uint32_t runStartMs = 0;
int16_t worstPct = -1;        // -1 = none
uint16_t batX100 = 0;
char stopReason = 'P';
bool bleReady = false;
bool wasConnected = false;
bool trainRunning = false;
uint32_t lastStatusMs = 0;
uint32_t lastBatMs = 0;
uint32_t lastHoldSampleMs = 0;
uint32_t holdSum = 0;
uint16_t holdN = 0;

uint32_t nrfPin(pin_size_t p) { return (uint32_t)digitalPinToPinName(p); }
float targetMA() { return currentX10 / 10.0f; }
uint32_t refCode() { return (uint32_t)(targetMA() * 1e-3f * R_SENSE_OHM / LOGIC_HIGH_V * PWM_COUNTS + 0.5f); }

/* ---------- reference PWM (12-bit, from v1) ---------- */
void refInit() {
  pinMode(PIN_REFERENCE, OUTPUT);
  digitalWrite(PIN_REFERENCE, LOW);
  REF_PWM->ENABLE = 0;
  REF_PWM->PSEL.OUT[0] = nrfPin(PIN_REFERENCE);
  REF_PWM->PSEL.OUT[1] = 0xFFFFFFFFUL;
  REF_PWM->PSEL.OUT[2] = 0xFFFFFFFFUL;
  REF_PWM->PSEL.OUT[3] = 0xFFFFFFFFUL;
  REF_PWM->MODE = PWM_MODE_UPDOWN_Up;
  REF_PWM->PRESCALER = PWM_PRESCALER_PRESCALER_DIV_1;
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
void refWriteCode(uint32_t code) {
  if (code > PWM_TOP) code = PWM_TOP;
  refSeq[0] = (uint16_t)(code | 0x8000);
  REF_PWM->EVENTS_SEQEND[0] = 0;
  REF_PWM->TASKS_SEQSTART[0] = 1;
}

/* ---------- SAADC (register level) ---------- */
void saadcConfig(uint8_t ain) {
  // V_sense input gets the SAADC's internal pull-down (~160 kohm): with no jumper D0 reads 0 V (red), not noise.
  // Against 220 ohm the pull-down changes the reading by < 0.2 %.
  const uint32_t resp = ain == SAADC_AIN_SENSE ? SAADC_CH_CONFIG_RESP_Pulldown : SAADC_CH_CONFIG_RESP_Bypass;
  NRF_SAADC->ENABLE = 0;
  NRF_SAADC->RESOLUTION = SAADC_RESOLUTION_VAL_12bit;
  NRF_SAADC->OVERSAMPLE = 0;
  NRF_SAADC->SAMPLERATE = 0;                         // sample on task only
  for (int i = 0; i < 8; i++) { NRF_SAADC->CH[i].PSELP = 0; NRF_SAADC->CH[i].PSELN = 0; }
  NRF_SAADC->CH[0].CONFIG = (resp << SAADC_CH_CONFIG_RESP_Pos) |
                            (SAADC_CH_CONFIG_RESN_Bypass << SAADC_CH_CONFIG_RESN_Pos) |
                            (SAADC_CH_CONFIG_GAIN_Gain1_6 << SAADC_CH_CONFIG_GAIN_Pos) |
                            (SAADC_CH_CONFIG_REFSEL_Internal << SAADC_CH_CONFIG_REFSEL_Pos) |
                            (SAADC_CH_CONFIG_TACQ_40us << SAADC_CH_CONFIG_TACQ_Pos) |
                            (SAADC_CH_CONFIG_MODE_SE << SAADC_CH_CONFIG_MODE_Pos) |
                            (SAADC_CH_CONFIG_BURST_Disabled << SAADC_CH_CONFIG_BURST_Pos);
  NRF_SAADC->CH[0].PSELP = ain;
  NRF_SAADC->INTENCLR = 0xFFFFFFFFUL;
  NRF_SAADC->ENABLE = 1;
}
void saadcCalibrate() {
  saadcConfig(SAADC_AIN_SENSE);
  NRF_SAADC->EVENTS_CALIBRATEDONE = 0;
  NRF_SAADC->TASKS_CALIBRATEOFFSET = 1;
  const uint32_t t0 = millis();
  while (!NRF_SAADC->EVENTS_CALIBRATEDONE && millis() - t0 < 50) {}
  NRF_SAADC->EVENTS_CALIBRATEDONE = 0;
}
void saadcStartBuffer(int16_t *buf, uint16_t n) {
  NRF_SAADC->RESULT.PTR = (uint32_t)buf;
  NRF_SAADC->RESULT.MAXCNT = n;
  NRF_SAADC->EVENTS_STARTED = 0;
  NRF_SAADC->EVENTS_END = 0;
  NRF_SAADC->TASKS_START = 1;
  const uint32_t t0 = micros();
  while (!NRF_SAADC->EVENTS_STARTED && micros() - t0 < 1000) {}
}
void saadcStop() {
  NRF_SAADC->EVENTS_STOPPED = 0;
  NRF_SAADC->TASKS_STOP = 1;
  const uint32_t t0 = micros();
  while (!NRF_SAADC->EVENTS_STOPPED && micros() - t0 < 1000) {}
}
int16_t saadcReadOnce(uint8_t ain) {          // blocking, ~50 us; only while no train is running
  saadcConfig(ain);
  saadcStartBuffer((int16_t *)&oneSample, 1);
  NRF_SAADC->TASKS_SAMPLE = 1;
  const uint32_t t0 = micros();
  while (!NRF_SAADC->EVENTS_END && micros() - t0 < 2000) {}
  saadcStop();
  return oneSample < 0 ? 0 : oneSample;
}
float rawToV(int32_t raw) { return raw * SAADC_FULL_V / 4096.0f; }
int16_t pctFromRaw(float rawAvg) {
  const float mA = rawToV(rawAvg) / R_SENSE_OHM * 1000.0f;
  int p = (int)(mA / targetMA() * 100.0f + 0.5f);
  if (p < 0) p = 0;
  if (p > 199) p = 199;
  return (int16_t)p;
}
void readBattery() {
  NRF_P0->PIN_CNF[VBAT_ENABLE_PIN] = (GPIO_PIN_CNF_DIR_Output << GPIO_PIN_CNF_DIR_Pos);
  NRF_P0->OUTCLR = (1UL << VBAT_ENABLE_PIN);
  const float v = rawToV(saadcReadOnce(SAADC_AIN_VBAT)) * VBAT_SCALE;
  batX100 = (uint16_t)(v * 100.0f + 0.5f);
  lastBatMs = millis();
}

/* ---------- status ---------- */
char stateChar(State s) {
  switch (s) {
    case State::STOP:     return '0';
    case State::SETTLING: return 'W';
    case State::BURST:    return 'B';
    case State::GAP:      return 'G';
    case State::HOLD:     return 'H';
    case State::LED:      return 'L';
  }
  return '?';
}
uint16_t pulsesDone() {
  if (!trainRunning) return 0;
  COUNT_TIMER->TASKS_CAPTURE[1] = 1;
  return (uint16_t)COUNT_TIMER->CC[1];
}
void sendStatus() {
  char pct[5] = "-";
  if (worstPct >= 0) snprintf(pct, sizeof(pct), "%d", worstPct);
  char buf[24];
  snprintf(buf, sizeof(buf), "%c,%u,%u,%s,%u,%c", stateChar(state), (unsigned)burstNo,
           (unsigned)pulsesDone(), pct, (unsigned)batX100, state == State::STOP ? stopReason : '-');
  if (bleReady) statusChar.writeValue(buf);
  Serial.print("[status] ");
  Serial.println(buf);
  lastStatusMs = millis();
}

/* ---------- hardware pulse train ---------- */
uint32_t gpioteConfig(uint32_t pin, bool initHigh) {
  return (GPIOTE_CONFIG_MODE_Task << GPIOTE_CONFIG_MODE_Pos) |
         ((pin & 31UL) << GPIOTE_CONFIG_PSEL_Pos) |
         ((pin >> 5) << GPIOTE_CONFIG_PORT_Pos) |
         (GPIOTE_CONFIG_POLARITY_Toggle << GPIOTE_CONFIG_POLARITY_Pos) |
         ((initHigh ? 1UL : 0UL) << GPIOTE_CONFIG_OUTINIT_Pos);
}
void ppiSet(uint8_t ch, volatile uint32_t *ev, volatile uint32_t *task, volatile uint32_t *fork) {
  NRF_PPI->CH[ch].EEP = (uint32_t)ev;
  NRF_PPI->CH[ch].TEP = (uint32_t)task;
  NRF_PPI->FORK[ch].TEP = (uint32_t)fork;
}

// Starts one train of nPulses with the given shape. Output must be at REST (SEL1=0, SEL2=1) and EN=1.
void trainStart(Shape shape, uint16_t nPulses) {
  NRF_CLOCK->TASKS_HFCLKSTART = 1;            // crystal for an accurate pulse period
  NRF_PPI->CHENCLR = PPI_MASK;

  const uint32_t t0 = T_LEAD_US * TICKS_PER_US;
  const uint32_t pw = (uint32_t)pwUs * TICKS_PER_US;
  PULSE_TIMER->TASKS_STOP = 1;
  PULSE_TIMER->TASKS_CLEAR = 1;
  PULSE_TIMER->MODE = TIMER_MODE_MODE_Timer;
  PULSE_TIMER->BITMODE = TIMER_BITMODE_BITMODE_32Bit;
  PULSE_TIMER->PRESCALER = 0;
  PULSE_TIMER->CC[0] = t0;
  PULSE_TIMER->CC[1] = t0 + pw;
  PULSE_TIMER->CC[2] = t0 + 2 * pw;
  PULSE_TIMER->CC[3] = periodUs * TICKS_PER_US;
  PULSE_TIMER->SHORTS = TIMER_SHORTS_COMPARE3_CLEAR_Msk;
  for (int i = 0; i < 4; i++) PULSE_TIMER->EVENTS_COMPARE[i] = 0;

  COUNT_TIMER->TASKS_STOP = 1;
  COUNT_TIMER->TASKS_CLEAR = 1;
  COUNT_TIMER->MODE = TIMER_MODE_MODE_Counter;
  COUNT_TIMER->BITMODE = TIMER_BITMODE_BITMODE_16Bit;
  COUNT_TIMER->CC[0] = nPulses;
  COUNT_TIMER->SHORTS = 0;
  COUNT_TIMER->EVENTS_COMPARE[0] = 0;
  COUNT_TIMER->TASKS_START = 1;

  // REST levels, then hand the pins to GPIOTE with the same levels.
  sel1Out->write(0);
  sel2Out->write(1);
  NRF_GPIOTE->CONFIG[GPIOTE_CH_SEL1] = gpioteConfig(nrfPin(PIN_SEL1), false);
  NRF_GPIOTE->CONFIG[GPIOTE_CH_SEL2] = gpioteConfig(nrfPin(PIN_SEL2), true);

  volatile uint32_t *set1 = &NRF_GPIOTE->TASKS_SET[GPIOTE_CH_SEL1], *clr1 = &NRF_GPIOTE->TASKS_CLR[GPIOTE_CH_SEL1];
  volatile uint32_t *set2 = &NRF_GPIOTE->TASKS_SET[GPIOTE_CH_SEL2], *clr2 = &NRF_GPIOTE->TASKS_CLR[GPIOTE_CH_SEL2];
  volatile uint32_t *sample = &NRF_SAADC->TASKS_SAMPLE, *count = &COUNT_TIMER->TASKS_COUNT;
  volatile uint32_t *ev0 = &PULSE_TIMER->EVENTS_COMPARE[0], *ev1 = &PULSE_TIMER->EVENTS_COMPARE[1],
                    *ev2 = &PULSE_TIMER->EVENTS_COMPARE[2];
  uint32_t mask = PPI_MASK;
  if (shape == Shape::BIPHASIC) {            // REST(0,1) -> C(0,0) -> A(1,1) -> REST(0,1)
    ppiSet(PPI_CH_0, ev0, clr2, sample);
    ppiSet(PPI_CH_1, ev1, set1, set2);
    ppiSet(PPI_CH_2, ev2, clr1, count);
  } else if (shape == Shape::BIPHASIC_A) {   // REST(0,1) -> A(1,1) -> C(0,0) -> REST(0,1)
    ppiSet(PPI_CH_0, ev0, set1, sample);
    ppiSet(PPI_CH_1, ev1, clr1, clr2);
    ppiSet(PPI_CH_2, ev2, set2, count);
  } else if (shape == Shape::MONO_CATH) {    // REST(0,1) -> C(0,0) -> REST
    ppiSet(PPI_CH_0, ev0, clr2, sample);
    ppiSet(PPI_CH_1, ev1, set2, count);
    mask &= ~(1UL << PPI_CH_2);
  } else {                                   // REST(0,1) -> A(1,1) -> REST
    ppiSet(PPI_CH_0, ev0, set1, sample);
    ppiSet(PPI_CH_1, ev1, clr1, count);
    mask &= ~(1UL << PPI_CH_2);
  }
  ppiSet(PPI_CH_STOP, &COUNT_TIMER->EVENTS_COMPARE[0], &PULSE_TIMER->TASKS_STOP, nullptr);

  saadcConfig(SAADC_AIN_SENSE);
  saadcStartBuffer(senseBuf, nPulses <= 256 ? nPulses : 256);

  NRF_PPI->CHENSET = mask;
  enOut->write(1);                           // REST: both electrodes on the sink, 0 V between them
  trainRunning = true;
  PULSE_TIMER->TASKS_START = 1;
}

// Returns the % of set current measured in this train (-1 if no samples). Leaves EN as it is.
int16_t trainFinish() {
  PULSE_TIMER->TASKS_STOP = 1;
  NRF_PPI->CHENCLR = PPI_MASK;
  COUNT_TIMER->TASKS_STOP = 1;
  sel1Out->write(0);
  sel2Out->write(1);
  NRF_GPIOTE->CONFIG[GPIOTE_CH_SEL1] = 0;    // pins back to GPIO, REST levels
  NRF_GPIOTE->CONFIG[GPIOTE_CH_SEL2] = 0;
  trainRunning = false;
  saadcStop();                               // RESULT.AMOUNT is valid after END or STOPPED
  uint32_t n = NRF_SAADC->RESULT.AMOUNT;
  if (n > 256) n = 256;
  if (n < 3) return n == 0 ? -1 : pctFromRaw(senseBuf[n - 1] < 0 ? 0 : senseBuf[n - 1]);
  int32_t sum = 0;
  for (uint32_t i = 2; i < n; i++) sum += senseBuf[i] < 0 ? 0 : senseBuf[i];   // skip the first 2 pulses
  return pctFromRaw((float)sum / (float)(n - 2));
}
bool trainDone() { return trainRunning && COUNT_TIMER->EVENTS_COMPARE[0]; }

void noteWorst(int16_t p) {
  if (p < 0 || !HAS_SENSE_JUMPER) return;
  if (worstPct < 0) { worstPct = p; return; }
  // "worst" = farthest from 100 %
  if (abs(p - 100) > abs(worstPct - 100)) worstPct = p;
}

/* ---------- states ---------- */
void stopAll(char reason) {
  enOut->write(0);
  if (trainRunning) noteWorst(trainFinish());
  sel1Out->write(0);
  sel2Out->write(0);
  refWriteCode(0);
  digitalWrite(LED_BUILTIN, HIGH);
  state = State::STOP;
  stopReason = reason;
  stateStartMs = millis();
  sendStatus();
}

void startSettling(State next) {
  enOut->write(0);
  refWriteCode(refCode());
  worstPct = -1;
  burstNo = 0;
  afterSettle = next;
  state = State::SETTLING;
  stateStartMs = runStartMs = millis();
  sendStatus();
}

void beginBurst() {
  burstNo++;
  state = State::BURST;
  stateStartMs = millis();
  trainStart(anodicFirst ? Shape::BIPHASIC_A : Shape::BIPHASIC, PULSES_PER_BURST);
  sendStatus();
}

void beginLedHalf() {
  burstNo = burstNo == 1 ? 2 : 1;
  state = State::LED;
  trainStart(burstNo == 1 ? Shape::MONO_CATH : Shape::MONO_ANOD, LED_HALF_PULSES);
}

void beginHold() {
  state = State::HOLD;
  stateStartMs = millis();
  holdSum = 0; holdN = 0; lastHoldSampleMs = millis();
  sel1Out->write(holdAnodic ? 1 : 0);
  sel2Out->write(holdAnodic ? 1 : 0);
  enOut->write(1);
  sendStatus();
}

void enterAfterSettle() {
  digitalWrite(LED_BUILTIN, LOW);
  if (afterSettle == State::BURST) beginBurst();
  else if (afterSettle == State::HOLD) beginHold();
  else if (afterSettle == State::LED) { burstNo = 2; stateStartMs = millis(); beginLedHalf(); sendStatus(); }
  else stopAll('E');
}

/* ---------- commands ---------- */
bool parseUInt(const char *&p, long &out) {
  if (*p < '0' || *p > '9') return false;
  out = 0;
  while (*p >= '0' && *p <= '9') { out = out * 10 + (*p - '0'); p++; if (out > 100000) return false; }
  return true;
}

void handleCommand(const char *s) {
  while (*s == ' ' || *s == '\r' || *s == '\n') s++;
  if (*s == 0) return;
  const char c = *s;
  if (c == '?') { sendStatus(); return; }
  if (c == 'S' || c == 's' || c == '0') { stopAll('U'); return; }
  if (state != State::STOP) { stopAll('E'); return; }     // start only from STOP

  const char *p = s + 1;
  long i10 = 0, pw = 0, n = 0;
  uint32_t newPeriod = DEFAULT_PERIOD_US, newGap = DEFAULT_GAP_MS;
  bool newAFirst = true;
  bool ok = false;
  if (c == 'B') {
    ok = parseUInt(p, i10) && *p++ == ',' && parseUInt(p, pw) && *p++ == ',' && parseUInt(p, n);
    ok = ok && n >= 1 && n <= MAX_BURSTS;
    newPeriod = DEFAULT_PERIOD_US; newGap = DEFAULT_GAP_MS;
    if (ok && *p == ',') {
      p++; long v = 0;
      ok = parseUInt(p, v);
      if (ok && v <= 30) {                                   // short form (app): ,<gap s>[,A|C]  fits the 20-byte BLE write
        newGap = (uint32_t)v * 1000UL;
        ok = newGap >= MIN_GAP_MS && newGap <= MAX_GAP_MS;
      } else if (ok) {                                       // long form (Serial): ,<period us>[,<gap ms>]
        ok = v >= 100 && v <= (long)MAX_PERIOD_US;
        if (ok) newPeriod = (uint32_t)v;
        if (ok && *p == ',' && p[1] >= '0' && p[1] <= '9') { p++; long g = 0; ok = parseUInt(p, g) && g >= (long)MIN_GAP_MS && g <= (long)MAX_GAP_MS; newGap = (uint32_t)g; }
      }
      if (ok && *p == ',') { p++; const char o = *p++; ok = o == 'A' || o == 'C'; newAFirst = o == 'A'; }   // ,A = + first (default), ,C = - first
    }
  } else if (c == 'H') {
    const char sign = *p++;
    ok = (sign == '+' || sign == '-') && parseUInt(p, i10);
    holdAnodic = sign == '+';
    pw = MIN_PW_US;
  } else if (c == 'L') {
    ok = parseUInt(p, i10) && *p++ == ',' && parseUInt(p, pw);
    newPeriod = LED_PERIOD_US;
  }
  while (ok && (*p == ' ' || *p == '\r' || *p == '\n')) p++;
  const long maxI10 = c == 'L' ? LED_REQ_MAX_X10 : MAX_CURRENT_X10;
  ok = ok && *p == 0 && i10 >= MIN_CURRENT_X10 && i10 <= maxI10 && pw >= MIN_PW_US && pw <= MAX_PW_US;
  ok = ok && newPeriod <= MAX_PERIOD_US && newPeriod >= T_LEAD_US + 2 * (uint32_t)pw + 50;   // both phases + rest fit
  if (!ok) {
    Serial.print("Bad command: ");
    Serial.println(s);
    stopAll('E');
    return;
  }
  if (c == 'L' && i10 > LED_CAP_X10) i10 = LED_CAP_X10;   // what this board's R_sense allows
  currentX10 = (uint8_t)i10;
  pwUs = (uint16_t)pw;
  periodUs = newPeriod;                      // H uses the default, L uses LED_PERIOD_US
  gapMs = newGap;
  anodicFirst = newAFirst;
  if (c == 'B') { nBursts = (uint8_t)n; startSettling(State::BURST); }
  else if (c == 'H') startSettling(State::HOLD);
  else startSettling(State::LED);
}

/* ---------- main loop ---------- */
void updateState() {
  const uint32_t now = millis();
  const uint32_t elapsed = now - stateStartMs;

  if (state == State::SETTLING && elapsed >= SETTLE_MS) { enterAfterSettle(); return; }

  if (state == State::BURST && trainDone()) {
    enOut->write(0);
    noteWorst(trainFinish());
    if (burstNo >= nBursts) { stopAll('F'); return; }
    state = State::GAP;
    stateStartMs = now;
    sendStatus();
    return;
  }
  if (state == State::GAP && elapsed >= gapMs) { beginBurst(); return; }

  if (state == State::LED) {
    if (now - runStartMs >= LED_MAX_MS + SETTLE_MS) { stopAll('T'); return; }
    if (trainDone()) { noteWorst(trainFinish()); beginLedHalf(); }
  }

  if (state == State::HOLD) {
    if (elapsed >= HOLD_MAX_MS) {
      enOut->write(0);
      stopAll('T');
      return;
    }
    if (elapsed >= 200 && now - lastHoldSampleMs >= 100) {
      holdSum += saadcReadOnce(SAADC_AIN_SENSE);
      holdN++;
      lastHoldSampleMs = now;
      if (HAS_SENSE_JUMPER) worstPct = pctFromRaw((float)holdSum / holdN);
    }
  }

  // Battery: only while no train is running (SAADC is free).
  if (!trainRunning && state != State::HOLD && now - lastBatMs >= 5000) readBattery();

  const uint32_t every = state == State::STOP ? 1000 : 200;
  if (now - lastStatusMs >= every) sendStatus();
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
  digitalWrite(LEDG, HIGH);                  // board LEDs are active low
  pinMode(LEDG, OUTPUT);
  digitalWrite(LEDB, HIGH);
  pinMode(LEDB, OUTPUT);
  Serial.begin(115200);

  snprintf(FW_ID, sizeof(FW_ID), "tES-YONSEI v2 B%u R%u", (unsigned)BOARD_ID, (unsigned)R_SENSE_OHM);
  saadcCalibrate();
  readBattery();

  if (BLE.begin()) {
    char name[12];
    snprintf(name, sizeof(name), "tES-Y2-B%u", (unsigned)BOARD_ID);
    BLE.setLocalName(name);
    BLE.setDeviceName(name);
    BLE.setAdvertisedService(ySvc);
    ySvc.addCharacteristic(cmdChar);
    ySvc.addCharacteristic(statusChar);
    ySvc.addCharacteristic(fwChar);
    BLE.addService(ySvc);
    fwChar.writeValue(FW_ID);
    cmdChar.writeValue("S");
    BLE.advertise();
    bleReady = true;
  }
  stopAll('P');
}

void loop() {
  static bool serialWasOpen = false;
  static char line[24];
  static uint8_t lineLen = 0;
  const bool serialOpen = static_cast<bool>(Serial);
  if (serialOpen && !serialWasOpen) {
    Serial.println("\n=== tES-YONSEI v2 ===");
    Serial.println(FW_ID);
    Serial.println(bleReady ? "BLE ready" : "BLE init FAILED (Serial control only)");
    Serial.println("S stop | B<I x10>,<pw us>,<bursts>[,<period us>[,<gap ms>[,A|C]]] | H+<I> H-<I> | L<I>,<pw> | ?   e.g. B30,500,5");
    Serial.print("LED test max ");
    Serial.print(LED_CAP_X10 / 10.0f, 1);
    Serial.println(" mA on this board");
    sendStatus();
  }
  serialWasOpen = serialOpen;

  while (Serial.available() > 0) {
    const char ch = static_cast<char>(Serial.read());
    if (ch == '\n' || ch == '\r') {
      line[lineLen] = 0;
      if (lineLen) handleCommand(line);
      lineLen = 0;
    } else if (lineLen < sizeof(line) - 1) {
      line[lineLen++] = ch;
    }
  }

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
    if (connected && cmdChar.written()) handleCommand(cmdChar.value().c_str());
    // board LEDs: one short blink every 2 s (almost no battery): blue = phone connected, green = waiting for the phone
    const bool blink = millis() % 2000 < 80;
    digitalWrite(LEDB, (connected && blink) ? LOW : HIGH);
    digitalWrite(LEDG, (!connected && blink) ? LOW : HIGH);
  }

  updateState();
  delay(1);
}
