# signalk-ac10-autopilot

Signal K server plugin for a **Simrad AC10** autopilot computer. It is meant as a drop-in replacement for
[`@signalk/signalk-autopilot`](https://github.com/SignalK/signalk-autopilot): it registers the same v1 PUT paths, the
same Autopilot V2 API provider and the same remote-control webapp, so KIP, Freeboard and similar clients work unchanged.

The AC10 has **no NMEA 2000**, and NMEA 0183 cannot change autopilot mode. So control goes through two links:

1. **An ESPHome ESP32 on the AC10 REMOTE port (TB7: Lamp / Stbd / Port / Gnd).** It emulates an R3000X remote and,
   by default, talks to the Signal K server itself through ESPHomeSignalK (`transport: signalk`):
   - It publishes `steering.autopilot.ac10.engaged` (Lamp; also a 2 s heartbeat) and `.steps` (queued steps).
   - It takes PUTs on both paths. The server forwards a PUT to the WS client that publishes the path; the plugin sends
     them with `app.putSelfPath`, and the firmware replies 200 or 4xx with a reason.
   - The older `transport: http` (plugin → ESPHome web_server REST + SSE) is kept.
   - The STBY-AUTO key toggles STANDBY ↔ AUTO (or WIND if WIND is selected in the AC10 User Setup).
   - Port/Stbd presses change the set course by 1° each, in AUTO/WIND only.
   - The Lamp output means "engaged".
2. **NMEA 0183 on the AC10's single NMEA port.**
   - AC10 → Signal K: HDG, RSA and HSC. The server's own parser turns these into `navigation.headingMagnetic`,
     `steering.rudderAngle` and `steering.autopilot.target.headingMagnetic`.
   - Signal K → AC10: APB/RMB/XTE/MWV/VHW/RMC, sent by the `signalk-to-nmea0183` plugin rather than this one.

NAV and WINDN on the AC10 can only be entered from the control head. The plugin's `route` state is therefore
plugin-steered: the AC10 stays in AUTO and the plugin steps the set course along the active Signal K course leg
(track bearing + XTE correction, same law as the upstream emulator).

## Layout

| Path | What |
|---|---|
| `src/index.ts` | Plugin entry (`export =`): config schema, PUT handlers (reply PENDING, complete via callback), V2 `AutopilotProvider` (device id `ac10`). Plugin id `ac10-autopilot`. |
| `src/ac10.ts` | `AC10Pilot`: state machine, target tracking, steps, wind/tack logic, route loop, notifications. Depends only on the small `Remote` (connected/engaged/pendingSteps/description, start/stop/engage/standby/steps, events) and `PilotApp` interfaces, so tests can fake them. |
| `src/signalk-remote.ts` | `SignalKRemote` (default transport): subscribes to `<prefix>.engaged`/`.steps` on the self bus, goes offline after 6 s without heartbeat, sends PUTs via `putSelfPath` (PENDING ignored, 2xx resolves, else rejects with the device message, 5 s timeout). |
| `src/esphome.ts` | `EspHomeRemote`: ESPHome `web_server` client. Sends REST POSTs (`/button/<id>/press`, `/number/ap_steps/set?value=n`) and reads the SSE `/events` stream for `ap_engaged` and `ap_pending_steps`. Supports Basic and Digest auth, reconnects with backoff, drops a stale stream after 30 s. |
| `src/angles.ts` | Angle helpers and `routeHeading()`. |
| `esphome/ac10-remote.yaml` | Firmware, hardware part: ESP32, Wi-Fi, web_server, `signalk:` connection, GPIO outputs and Lamp input. Includes `ac10-logic.yaml` as a package. Uses ESPHomeSignalK from a local path `../../ESPHomeSignalK/components` (branch `feat/put-handlers`, not merged yet). |
| `esphome/ac10-logic.yaml` | Firmware, hardware-independent part: `on_put` handlers, heartbeat, key scripts, all timing and safety interlocks. |
| `test/e2e/` | `run.sh`: throwaway signalk-server (port 3300, temp config dir) + this plugin + `ac10-sim.yaml` (host build of the logic with a simulated AC10). Run `ESPHOME=<venv>/bin/esphome bash test/e2e/run.sh`. |
| `docs/HARDWARE.md` | Remote-port investigation (from Simrad AP25 manual 20221495), measurement checklist, block diagram, parts and values, safety design. |
| `public-src/` | Vendored signalk-autopilot remote GUI (Apache-2.0; upstream commit in `public-src/UPSTREAM`). |
| `scripts/build-gui.mjs` | Bundles the GUI into `public/` without webpack: strips `export` and wraps the code in a global `autopilot`. |
| `test/` | mocha + chai via tsx. `helpers.ts` has `FakeRemote` (behaves like the firmware) and `FakeApp`. `esphome.test.ts` runs a real HTTP/SSE server. |

## Commands

```sh
npm install
npm run build   # tsc -> dist/, then GUI bundle -> public/
npm test        # mocha, 44 tests
ESPHOME=<venv>/bin/esphome bash test/e2e/run.sh   # end to end, needs ../ESPHomeSignalK
```

Validate or compile the firmware (ESPHome is not installed globally; use a venv and a dummy `secrets.yaml`):

```sh
esphome config esphome/ac10-remote.yaml
esphome compile esphome/ac10-remote.yaml
```

## Design rules (keep these)

- **The firmware owns timing.** Every output is a firmware-timed pulse, and the plugin never "holds" a key. Never add
  an API that leaves an output on.
- **NFU guard.** Port/Stbd in STANDBY moves the rudder. Both the firmware (`lamp` check in the steps PUT, in
  `queue_steps` and in the step loop) and the plugin (`requireEngaged`) refuse steps unless engaged.
- **Lamp is the source of truth** for engaged/standby. Every state change waits for Lamp confirmation
  (`confirmTimeout`). If the ESPHome link is down, the state is `null` and commands are refused.
- **`ap_engage`, `ap_standby` and the `engaged` PUT are idempotent** (they check the Lamp before toggling).
  `ap_mode_toggle` is a raw diagnostic only.
- **Plugin PUT handlers complete via `setImmediate`.** Calling the callback before the server records the returned
  PENDING leaves the request stuck at 202.
- **Entity `name` == object id** (`ap_engaged`, `ap_steps`, ...). Current ESPHome addresses web_server URLs and SSE ids
  by *name* (`binary_sensor/ap_engaged`); older versions use `binary_sensor-ap_engaged`. The client accepts both.
- **Sign convention:** adjustment degrees are positive = starboard, as on the R3000X keys. In WIND mode the wind-angle
  target moves the opposite way: `target -= steps`.
- **When route data is lost, keep holding course in AUTO** and raise `notifications.autopilot.routeDataLost`. Never
  drop to standby.
- **The plugin's own target deltas are ignored as HSC input** (filtered by `$source === 'ac10-autopilot'`). HSC is also
  ignored for 3 s after a command and while steps are pending.

## Status (2026-11-15)

Done:
- Plugin with all signalk-autopilot PUT paths, the V2 provider, the vendored GUI, and notifications
  (`remoteOffline`, `routeDataLost`).
- States: standby, auto|wind (whichever `engagedMode` is configured), and plugin-steered route.
- Actions: adjust, absolute heading or wind target (shortest turn), tack (AUTO: ±`tackAngle`; WIND: mirror the AWA and
  refuse a turn that would gybe), advance waypoint (via `app.getCourse()` / `app.activateRoute()`).
- Not supported: gybe, dodge, modes.
- ESPHome YAML validates and compiles (ESPHome 2026.10.2, esp-idf, esp32dev). Web auth is `digest`.
- Signal K transport via ESPHomeSignalK PUT support (default), firmware split into hardware + logic files.
- 44 unit tests pass; the end-to-end test (real signalk-server + host-built firmware logic) passes.

Not done / unverified:
- **Never run against a real AC10.** Only unit tests and the simulated end-to-end test.
- ESPHomeSignalK PUT support is on its local `feat/put-handlers` branch (not pushed/merged). Once merged, switch
  `external_components` in `ac10-remote.yaml` and `test/e2e/ac10-sim.yaml` to `github://batuakan/ESPHomeSignalK@main`.
- Hardware unknowns the manual does not state (see `docs/HARDWARE.md` §2):
  - how the STBY-AUTO key is signalled (assumed: Port+Stbd to Gnd together; alternative: Lamp→Gnd);
  - Port/Stbd voltage and current;
  - Lamp voltage and whether it blinks;
  - whether the AC10 really outputs HSC;
  - `press_ms`/`gap_ms` that give exactly 1° per press.
  When measurements arrive, update the YAML substitutions and the docs. Don't re-research.
- Optional NMEA 0183 TCP bridge on the ESP (`stream_server`) is only a commented-out block in the YAML.
- No lint/prettier config. Not published to npm. Not pushed.
- Untested idea: if the control head has SimNet, check whether it accepts Simnet PGN 130850 commands over a SimNet→N2K
  cable.
