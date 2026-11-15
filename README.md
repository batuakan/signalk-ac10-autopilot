# signalk-ac10-autopilot

A Signal K server plugin that controls a **Simrad AC10** autopilot computer.
It is a drop-in replacement for
[`@signalk/signalk-autopilot`](https://github.com/SignalK/signalk-autopilot):
it uses the same PUT paths, the same Autopilot V2 API provider and the same
remote-control web app. KIP, Freeboard-SK, WilhelmSK and similar clients
work unchanged.

The AC10 has no NMEA 2000 interface, and NMEA 0183 has no sentence to change
autopilot mode. So the plugin uses two links:

```
                      NMEA 0183 (4800 baud, AC10 NMEA port)
         ┌──────────────── HDG, RSA, HSC ───────────────────┐
         │                                                  ▼
  ┌──────┴─────┐                                    ┌────────────────┐
  │ Simrad AC10│◄─── APB/RMB/XTE, MWV, VHW/RMC ─────│ Signal K server│
  │            │                                    │  + this plugin │
  │  TB7       │                                    │  + signalk-to- │
  │  REMOTE    │◄── Port/Stbd/STBY-AUTO keys ──┐    │    nmea0183    │
  │  (R3000X)  │─── Lamp (= engaged) ───────┐  │    └───────▲────────┘
  └────────────┘                            ▼  │            │ Signal K WebSocket
                                       ┌───────┴───┐        │ (deltas + PUTs)
                                       │ ESP32 /   │────────┘
                                       │ ESPHome   │
                                       └───────────┘
```

* **ESPHome device on the AC10 REMOTE port.** It emulates an R3000X remote:
  the STBY-AUTO key and 1° Port/Stbd steps. It reads the remote's lamp output
  as the "engaged" state. It connects to the Signal K server itself with
  [ESPHomeSignalK](https://github.com/batuakan/ESPHomeSignalK): it publishes
  `steering.autopilot.ac10.engaged` (Lamp, plus a 2 s heartbeat) and
  `steering.autopilot.ac10.steps` (queued steps), and takes PUTs on both. The
  plugin sends its commands as PUTs through the server, and the firmware answers
  each one, with a 4xx reason when it refuses. Firmware:
  [`esphome/ac10-remote.yaml`](esphome/ac10-remote.yaml) (GPIOs) and
  [`esphome/ac10-logic.yaml`](esphome/ac10-logic.yaml) (PUT handling, key
  sequences, safety guards). The older `http` transport (plugin → ESPHome
  `web_server` REST + SSE) still works.
  Hardware design and the port investigation: [`docs/HARDWARE.md`](docs/HARDWARE.md).
* **NMEA 0183.** The server parses the AC10's HDG, RSA and HSC sentences into
  heading, rudder angle and set course. `signalk-to-nmea0183` sends navigation
  and wind data to the AC10.

## Feature mapping

| signalk-autopilot API | AC10 implementation |
|---|---|
| `state` = `standby` / `auto` | STBY-AUTO key, confirmed by the Lamp |
| `state` = `wind` | STBY-AUTO key, **if** WIND is selected in the AC10 User Setup *and* `engagedMode` = `wind` |
| `state` = `route` | AC10 in AUTO, with the plugin stepping the set course along the active Signal K course leg (track bearing + XTE correction) |
| `actions.adjustHeading` (± degrees) | N × 1° key presses, queued on the ESP |
| `target.headingMagnetic` / `target.windAngleApparent` | Shortest turn from the current set course, sent as 1° steps |
| `actions.tack` | AUTO: ±`tackAngle`. WIND: mirrors the apparent wind angle, and refuses a turn that would gybe |
| `actions.advanceWaypoint` | Signal K Course API: activate the next route point |
| V2: gybe, dodge, modes | not supported (the remote port cannot do them) |

NAV and WINDN on the AC10 itself can only be entered from the control head,
which needs APB/RMB from `signalk-to-nmea0183`. If you choose NAV there, the
plugin reports the pilot as engaged in `auto`, because the Lamp cannot tell
the automatic modes apart.

## Setup

1. **Hardware.** Build the interface ([`docs/HARDWARE.md`](docs/HARDWARE.md)),
   do the measurements in §2 first, and flash
   [`esphome/ac10-remote.yaml`](esphome/ac10-remote.yaml). ESPHome fetches
   ESPHomeSignalK from GitHub. Fill in
   `esphome/secrets.yaml` (`signalk_host` empty = find the server with mDNS;
   `signalk_username` empty = send an access request, approve it in the admin UI
   under Security → Access Requests). Use the ESPHome web
   UI to tune `press_ms`/`gap_ms` until ten `ap_stbd_1` presses give exactly 10°.
2. **NMEA 0183 connection.** In Signal K, add an NMEA 0183 serial
   connection (USB/RS-422 adapter at 4800 baud) or a TCP client connection
   (ESP `stream_server`) to the AC10 NMEA port. Set an **output event** name,
   e.g. `ac10out`.
3. **signalk-to-nmea0183.** Enable APB, RMB, XTE and RMC (for NAV on the
   head), MWV (wind) and VHW/VTG (speed), sending to the `ac10out` event.
4. **This plugin.** Keep the default `signalk` transport (or choose `http` and
   set the ESPHome host and web_server credentials), and set `engagedMode` to
   match the AC10 User Setup.
5. If you used `@signalk/signalk-autopilot` before, **disable it**. The two
   plugins register the same PUT paths.

Install from a checkout (on the Signal K server host):

```sh
npm install && npm run build
cd ~/.signalk && npm install /path/to/signalk-ac10-autopilot
```

## Configuration

| Setting | Default | |
|---|---|---|
| `transport` | `signalk` | `signalk`: device on ESPHomeSignalK, commands as PUTs through the server. `http`: plugin talks to the ESPHome web_server |
| `signalkPrefix` | `steering.autopilot.ac10` | Device paths (must match `sk_prefix` in the firmware) |
| `esphomeHost` / `esphomePort` | – / 80 | `http` only: ESPHome web_server address |
| `esphomeUsername` / `esphomePassword` | – | `http` only: web_server auth (Basic and Digest both work) |
| `engagedMode` | `auto` | What the STBY-AUTO key selects on your AC10 |
| `confirmTimeout` | 5 s | How long to wait for the Lamp to change |
| `maxAdjust` | 90° | Largest single course change |
| `tackAngle` | 100° | Tack in AUTO (0 = disabled) |
| `enableV2API` | true | Disable for KIP's v1 mode, as with signalk-autopilot |
| `route.*` | see admin UI | Correction interval, XTE lookahead and limit, max change per correction, deadband, data timeout |

## Signal K data published

* `steering.autopilot.state`: `standby` / `auto` / `wind` / `route` (null when unknown)
* `steering.autopilot.engaged`
* `steering.autopilot.target.headingMagnetic` or `.windAngleApparent`
* `notifications.autopilot.remoteOffline`: alarm while the ESP is unreachable (no heartbeat for 6 s, or the SSE stream is down)
* `notifications.autopilot.routeDataLost`: alarm when route following stops (the pilot keeps holding course in AUTO)

## Development

```sh
npm install
npm run build   # tsc + bundles the vendored remote GUI into public/
npm test        # mocha: pilot logic, Signal K PUT transport, ESPHome SSE/REST client, plugin wiring
```

End-to-end test: a throwaway Signal K server on port 3300 with this plugin, and
the firmware logic built for the host with a simulated AC10
([`test/e2e/ac10-sim.yaml`](test/e2e/ac10-sim.yaml)). It needs ESPHome,
signalk-server on the PATH, ixwebsocket for the host build, curl and jq:

```sh
ESPHOME=/path/to/venv/bin/esphome bash test/e2e/run.sh
```

The remote-control web app in `public-src/` is vendored from
signalk-autopilot (Apache-2.0, © Scott Bender and contributors; upstream
commit in `public-src/UPSTREAM`).

> ⚠️ An autopilot steers your boat. Test at the dock and then in open water,
> and keep the control head within reach. STANDBY on the control head always
> overrides this plugin.
