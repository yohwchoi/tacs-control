# PNU tES Diagnostic (v3)

Web Bluetooth app for diagnosing the XIAO tES PCB step by step. Open **https://yohwchoi.github.io/tacs-control/** in Android Chrome.

Pairs with firmware **`firmware/tES_Diag_v2/tES_Diag_v2.ino`** (device name `PNU_tES_Diag`). Older firmware (`PNU_tACS_Sense`) is rejected by the app.
The previous controller (v2) is in git history at commit `68c83e2`.

## Test flow

| Step | Command | Measure |
| --- | --- | --- |
| 1 Baseline | `0` STOP | BAT+, boost out (D2 cathode / C6), TMUX supply |
| 2 Reference | `r` | reference voltage (expected I × 470 Ω) |
| 3 Hold A | `a` | V_sense (top of 470 Ω) → real current, LED on? |
| 4 Hold B | `b` | same, other direction |
| 5 Slow | `s` | A 1 s / off / B 1 s / off × 5, visual |

Holds auto-stop after 30 s. Target current 0.5 / 1.0 / 2.0 mA (`l` / `m` / `h`, only while stopped). BLE disconnect stops the output.
STOP opens the TMUX switches; it does **not** turn off the boost rail (TPS61170 CTRL is tied to BAT+).

Measurements are saved only in the phone browser (localStorage). Use **텍스트 복사** or **CSV 다운로드** to keep them.

Bench use only. Electrodes carry indicator LEDs only — no person or animal.

## BLE protocol

| Item | UUID | Notes |
| --- | --- | --- |
| Service | `19b10000-e8f2-537e-4f6c-d104768a1214` | |
| Command | `19b10001-…` | write 1 ASCII byte: `0 r a b s l m h ?` |
| Status | `19b10002-…` | notify, `"<state>,<mA×10>,<sec>,<slow>,<reason>"` e.g. `A,10,12,-,-` |
| Firmware ID | `19b10003-…` | read, `tES-DIAG v2` |

State: `0` STOP, `R` ref, `W` settling, `A`, `B`, `S` slow. Stop reason: `U` user, `T` 30 s timeout, `F` slow done, `D` disconnect, `P` power-on.

## Development

Buildless HTML/CSS/JS. `sw.js` is network-first, so a new release appears on the next open; bump its cache name when files change.
