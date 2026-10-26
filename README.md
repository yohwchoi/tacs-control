# PNU tES Controller

An installable Web Bluetooth bench controller for the XIAO tES system. Open **https://yohwchoi.github.io/tacs-control/** in Android Chrome.

## Add to an Android home screen

1. Open the address in Chrome while online.
2. Tap **Install tES Controller** when available, or use Chrome's **⋮ → Install and create shortcut → Install**. Some versions use **Add to Home screen**.
3. Open **tES Control** from the new icon.

The app files are cached after the first successful online visit. Opening the app never starts a test. Connect to the board from the app each session; a home-screen icon does not remove Bluetooth permission requirements.

## Existing device controls

Power the board, turn on Bluetooth and select **Connect to XIAO**. Select the advertised device **PNU_tACS_Sense**. This is the firmware's legacy name; it is deliberately unchanged.

| Command | Existing behavior |
| --- | --- |
| Mode 1 | LED test |
| Mode 2 | Load test (10 kΩ label in the main controller) |
| Mode 3 | Boost-converter test |
| Boost value 0–31 | Existing hardware step |
| Stop | Mode 0, then boost step 0 if supported |

No current, frequency, pulse-width or duration settings have been added. Their meaning and limits must be checked against the installed firmware and hardware first. The voltage table is retained from the previous controller; it is **not measured telemetry**. No output or physical stop state is inferred from a successful BLE write.

The controller supports older firmware without the boost service: basic mode/stop buttons remain available, and boost controls are disabled. The legacy `tacs_control.html` address opens the same interface as `index.html`.

## Development

Buildless HTML, CSS and JavaScript; no dependencies or installation required. Serve these files from localhost for development, or deploy them to HTTPS for phone access. Opening a downloaded HTML file directly is not the installation workflow.

The app manifest uses relative URLs for GitHub Pages subpath compatibility. `sw.js` caches only the app shell. Increment its cache version whenever app files change. Updates wait until the prior app closes, or the user chooses **Reload update** while disconnected; the app does not reload an active connection automatically. Never persist or replay stimulation commands.

Bluetooth requires a supporting browser. Android Chrome is the intended phone environment. Connection/command tests using mocks do not replace testing with the physical XIAO and bench equipment.

## BLE protocol retained

All writes are one-byte unsigned values using `writeValueWithResponse`.

| Item | UUID |
| --- | --- |
| tES service | `19b10000-e8f2-537e-4f6c-d104768a1214` |
| Mode characteristic | `19b10001-e8f2-537e-4f6c-d104768a1214` |
| Boost service | `19b10020-e8f2-537e-4f6c-d104768a1214` |
| Boost characteristic | `19b10021-e8f2-537e-4f6c-d104768a1214` |

Reference: [Chrome Web Bluetooth](https://developer.chrome.com/docs/capabilities/bluetooth), [Android web app installation](https://support.google.com/chrome/answer/9658361?hl=en&co=GENIE.Platform%3DAndroid).
