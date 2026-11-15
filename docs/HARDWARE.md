# AC10 remote port and the ESPHome interface

## 1. What the AC10 REMOTE port is

Source: *Simrad AP25 Autopilot Instruction Manual* 20221495 (it covers the
AC10/AC20/AC40 computers; AP16 manuals describe the same R3000X behaviour).

**Terminal block TB7 "REMOTE"** on the AC10 Power PCB (manual §3.15, Fig. 3-15
and §3.17, Fig. 3-16) has four terminals:

| TB7 terminal | R3000X wire (Fig 3-15) | Function |
|---|---|---|
| Lamp | Yel | Output, lights the R3000X lamp while an automatic mode is active |
| Stbd | Grn | Input, Starboard key |
| Port | Red | Input, Port key |
| Gnd  | Blu | Common |

The figure is a terminal drawing, so the colour-to-terminal order above is my
reading of it. The manual also says to *"disregard the colour code on the
terminal label"* for the S35. **Go by the terminal names, not the colours.**
The S35 NFU lever and the JS10 joystick use the same terminals.

**Behaviour** (§2.6 *R3000X Remote Control (NFU)*):

| AC10 mode | Port / Stbd key | STBY-AUTO key |
|---|---|---|
| STANDBY | Rudder moves while held (NFU) | → AUTO (or WIND if selected in User Setup) |
| AUTO / WIND | Set course / wind angle changes **1° per press**; held = 3°/s | → STANDBY |
| NAV / WINDN | (not stated) | → STANDBY |

* NAV and WINDN *"can only be entered from the Control unit because you have
  to accept the prompt displays"*. The plugin therefore does route following
  itself: it keeps the AC10 in AUTO and steps the set course.
* *"When a NFU steering lever or remote control is operated, other control
  units become 'Inactive'."* After using the remote, a key press on the
  control head makes it active again. This is normal.
* The AC10 has **no external alarm output**. That is an AC20/AC40 feature.
* NMEA 0183: the AC10 has **one** port (input and output). Input sentences:
  APA, APB, BOD, BWC, BWR, BWW, DBT, DPT, GGA, GLL, MTW, MWV, RMA, RMB, RMC,
  VHW, VLW, VTG, XTE. Output sentences: HDG/HDM/HDT, RSA, HSC and more
  (§8.13). There is **no NMEA 0183 sentence to change mode or set course**,
  which is why the remote port is needed. An NMEA compass cannot be used on an
  AC10.

## 2. Measure these before connecting anything

The manual does not give the electrical levels or how the STBY-AUTO key is
signalled on a 4-wire cable. Measure them at the dock, **with the drive
disconnected or the clutch/bypass off**, and keep a hand on the STBY key.

1. **Port/Stbd open-circuit voltage** to Gnd, in STANDBY. You should see a
   pull-up, probably 5 V or the supply voltage.
2. **Port/Stbd short-circuit current**: put the meter on mA between Port and
   Gnd for under a second. The rudder will try to move. This sets the
   switch rating. A PhotoMOS rated ≥60 V / ≥0.4 A is a safe margin.
3. **Lamp voltage** in STANDBY and in AUTO, and whether it blinks during
   alarms. The firmware's 1.5 s `delayed_off` covers blinking. Size the
   optocoupler resistor from the AUTO voltage (§4).
4. **How STBY-AUTO is signalled.**
   * If you have an R3000X or S35, unplug it and check continuity between its
     wires while pressing the STBY-AUTO key.
   * Without one, try it in STANDBY: jumper **Port and Stbd to Gnd together**
     for about 0.3 s and see whether it enters AUTO. This is the firmware's
     default assumption.
   * If that is wrong, the other likely encoding is the key pulling **Lamp**
     to Gnd. In that case, fit a single PhotoMOS (K4) Lamp→Gnd on GPIO27
     instead of the dual K3. The firmware needs no change, because `out_mode`
     just drives whatever is fitted.
5. **HSC output.** In the Signal K Data Browser, check that
   `steering.autopilot.target.headingMagnetic` (from HSC) appears in AUTO. The
   plugin works without it but is more accurate with it.
6. **Step timing.** Use the ESPHome web UI (`ap_stbd_10` button) to confirm
   that 10 presses give exactly 10°. Raise `press_ms`/`gap_ms` in the YAML
   until they do.

## 3. Block diagram

```
                ┌────────────────────── ESPHome box (near the AC10) ───────────────────────┐
 12/24 V ─fuse─►│ TVS + reverse diode ─► 5 V buck ─► ESP32                                  │
                │                                     GPIO25 ─► PhotoMOS K1 ─┬─ TB7 Port    │
                │                                     GPIO26 ─► PhotoMOS K2 ─┼─ TB7 Stbd    │
                │                                     GPIO27 ─► dual PhotoMOS K3a/K3b       │
                │                                               (Port+Stbd → Gnd together)  │
                │                                    (alt. K4 on GPIO27: Lamp → Gnd, fitted │
                │                                     instead of K3 if §2.4 shows that)    │
                │                                     GPIO32 ◄─ AC-input opto ◄── TB7 Lamp  │
                │                                                         common ─ TB7 Gnd  │
                │  optional: UART2 ─ isolated RS-422 ─ AC10 NMEA 0183 TX/RX (4800 baud)     │
                │  optional: panel switch "REMOTE ENABLE" in the PhotoMOS common line       │
                └───────────────────────────── Wi-Fi / Ethernet ──► Signal K ───────────────┘
```

Wire TB7 in **parallel** with an existing R3000X or S35. All of them are
switches to Gnd, so they coexist.

## 4. Suggested parts and values

| Function | Part | Notes |
|---|---|---|
| MCU | ESP32-DevKitC (Wi-Fi), or **Olimex ESP32-POE-ISO** / WT32-ETH01 (wired Ethernet) | Ethernet is more reliable on a boat. For an Ethernet board, change `wifi:` to `ethernet:`. |
| Port, Stbd switches | Panasonic **AQY212EH** or Toshiba **TLP222A** PhotoMOS | Bipolar contacts, so line polarity doesn't matter. Galvanic isolation, no contact bounce, silent. LED: GPIO → 330 Ω → ~7 mA. |
| STBY-AUTO switch | Panasonic **AQW212** (dual) | One GPIO drives both LEDs, each through its own 330 Ω. Both lines close in the same instant, so the AC10 never sees a brief single-key NFU press. Don't use two separate GPIOs for this. |
| Lamp sense | **LTV-814** / H11AA1 AC-input opto | Works with either polarity. Series resistor ≈ (V_lamp − 1.2 V) / 3 mA: about 3.3 kΩ at 12 V, 1 kΩ at 5 V. Collector → GPIO32 (internal pull-up + 10 kΩ external), emitter → ESP GND, 100 nF filter. |
| Line protection | **SMBJ33CA** TVS from each TB7 line to Gnd, 100 Ω series on Port/Stbd | The AC10 is rated to 28 V. Keep leads short. |
| Pull-downs | 10 kΩ GPIO → GND on each PhotoMOS drive | Keeps outputs off during ESP32 reset and boot. |
| Power | 10–36 V-in buck to 5 V (Traco TSR 1-2450, Pololu D24V5F5), 0.5 A fuse, series Schottky, SMBJ33A | Take power from the AC10 supply side, so the box is off when the pilot is off. |
| NMEA 0183 bridge (optional) | RX: H11L1 / 6N137 opto. TX: MAX3485 / SN65HVD3082, or an isolated **ADM2587E** | Replaces a USB-NMEA adapter on the Signal K host. See the commented `stream_server` block in the YAML. |
| Enclosure | IP65 box, cable glands, pluggable terminal blocks, conformal coating | Mount it dry, next to the AC10. |

Why PhotoMOS and not relays or plain transistors: relays bounce, and each
bounce can register as a separate 1° step. Transistors need you to know the
line polarity and bond the ESP ground to the AC10 ground. A PhotoMOS has
neither problem.

## 5. Safety design (built into `esphome/ac10-logic.yaml`)

* **No latching outputs.** Every key press is timed in firmware, so a Wi-Fi
  drop or a Signal K crash cannot leave a key held.
* **NFU guard.** Course steps are refused unless the Lamp shows an automatic
  mode. In STANDBY, a Port/Stbd press would move the rudder.
* **STANDBY wins.** When the Lamp goes out (STBY pressed anywhere), all queued
  steps are cancelled. `ap_standby` also cancels steps before toggling.
* **Idempotent engage/standby.** `ap_engage` toggles only from STANDBY, and
  `ap_standby` only from an automatic mode. A repeated request can't flip the
  pilot back. A 1 s lockout follows every toggle. The Signal K PUT on
  `steering.autopilot.ac10.engaged` follows the same rule (it compares the
  requested value with the Lamp) and answers 409 during the lockout. Steps
  queued during the lockout wait for it to end.
* **Refusals are reported.** A step PUT while in STANDBY gets a 400 reply with
  the reason, and the plugin shows it to the client.
* **Mutual exclusion.** The Port, Stbd and mode outputs are never on together.
* **Plugin side.** Every state change is confirmed by the Lamp, and the plugin
  reports a failure on timeout. If the device's 2 s heartbeat stops for 6 s
  (signalk transport) or the ESPHome stream goes stale (http), the state
  becomes unknown, commands are refused, and the
  `notifications.autopilot.remoteOffline` alarm is raised. If route data is
  lost, the AC10 keeps holding the last course in AUTO and
  `notifications.autopilot.routeDataLost` is raised.
* **Recommended:** a panel switch in the PhotoMOS common (TB7 Gnd) line to
  physically disable remote control.

## 6. Worth knowing

* Your control unit (AP16/AP24/AP25/AP26/AP27...) may have a SimNet port, and
  a SimNet→NMEA 2000 cable would carry its data. I have not confirmed whether
  this AC10 generation accepts the Simnet PGN 130850 commands that the
  upstream `simrad` mode sends. If it did, that would replace the remote-port
  hardware for engage/standby. It's worth one test if you have the cable.
