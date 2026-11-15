#!/usr/bin/env bash
# End-to-end test: this plugin in a throwaway signalk-server (own config dir, port 3300, no mDNS, no
# NMEA/TCP listeners), talking through Signal K PUTs to a host build of the real firmware logic with a
# simulated AC10 (test/e2e/ac10-sim.yaml).
#
# Needs: npm run build done, signalk-server on PATH, esphome (ESPHOME=/path/to/esphome), ixwebsocket for
# the host build (ESPHomeSignalK is fetched from GitHub), curl, jq.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ESPHOME="${ESPHOME:-esphome}"
PORT=3300
BASE="http://127.0.0.1:$PORT"
WORK="$(mktemp -d)"
PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

[[ -f "$ROOT/dist/index.js" ]] || { echo "run npm run build first"; exit 1; }

echo "== building simulated device"
"$ESPHOME" compile "$ROOT/test/e2e/ac10-sim.yaml" >"$WORK/build.log" 2>&1 || { tail -40 "$WORK/build.log"; exit 1; }
BIN="$ROOT/test/e2e/.esphome/build/ac10-sim/.pioenvs/ac10-sim/program"

mkdir -p "$WORK/sk/node_modules" "$WORK/sk/plugin-config-data"
ln -s "$ROOT" "$WORK/sk/node_modules/signalk-ac10-autopilot"
cat >"$WORK/sk/settings.json" <<JSON
{"interfaces": {"nmea-tcp": false, "tcp": false}, "mdns": false, "pipedProviders": [],
 "security": {"strategy": "./tokensecurity"}}
JSON
echo '{"dependencies": {"signalk-ac10-autopilot": "*"}}' >"$WORK/sk/package.json"
cat >"$WORK/sk/plugin-config-data/ac10-autopilot.json" <<JSON
{"enabled": true, "configuration": {"transport": "signalk", "confirmTimeout": 5}}
JSON

echo "== starting signalk-server on $PORT"
SIGNALK_NODE_CONFIG_DIR="$WORK/sk" PORT=$PORT ADMINUSER=admin:e2e-secret signalk-server >"$WORK/server.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 60); do curl -sf "$BASE/signalk" >/dev/null && break; sleep 1; done
TOKEN=$(curl -sf -X POST -H 'Content-Type: application/json' -d '{"username":"admin","password":"e2e-secret"}' \
  "$BASE/signalk/v1/auth/login" | jq -r .token)
AUTH=(-H "Authorization: Bearer $TOKEN")

value() { curl -s "${AUTH[@]}" "$BASE/signalk/v1/api/vessels/self/${1//.//}/value"; }
deg() { jq -n "($(value "$1")) * 180 / 3.141592653589793 | round"; }
wait_for() { # wait_for PATH VALUE SECONDS
  for _ in $(seq $(( $3 * 4 ))); do [[ "$(value "$1")" == "$2" ]] && return 0; sleep 0.25; done
  return 1
}
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
# put PATH VALUE: PUT over REST, follow the request, print "<statusCode> <message>"
put() {
  local res href state
  res=$(curl -s -X PUT "${AUTH[@]}" -H 'Content-Type: application/json' -d "{\"value\": $2}" \
    "$BASE/signalk/v1/api/vessels/self/${1//.//}")
  state=$(jq -r .state <<<"$res"); href=$(jq -r '.href // empty' <<<"$res")
  for _ in $(seq 60); do
    [[ "$state" != "PENDING" || -z "$href" ]] && break
    sleep 0.25
    res=$(curl -s "${AUTH[@]}" "$BASE$href"); state=$(jq -r .state <<<"$res")
  done
  echo "$(jq -r .statusCode <<<"$res") $(jq -r '.message // ""' <<<"$res")"
}

echo "== starting simulated AC10 remote interface"
ESPHOME_PREFDIR="$WORK/prefs" "$BIN" >"$WORK/device.log" 2>&1 &
DEV=$!
PIDS+=($DEV)

check "plugin sees the device: state standby" 'wait_for steering.autopilot.state "\"standby\"" 30'

r=$(put steering.autopilot.state '"auto"')
check "PUT state auto -> 200 ($r)" '[[ "$r" == 200* ]]'
check "state is auto" 'wait_for steering.autopilot.state "\"auto\"" 5'
check "device reports engaged" '[[ "$(value steering.autopilot.ac10.engaged)" == "true" ]]'

r=$(put steering.autopilot.actions.adjustHeading 10)
check "adjustHeading +10 -> 200 ($r)" '[[ "$r" == 200* ]]'
sleep 2.5
check "simulated AC10 set course moved 90 -> 100 ($(deg steering.autopilot.target.headingMagnetic))" \
  '[[ "$(deg steering.autopilot.target.headingMagnetic)" == 100 ]]'

r=$(put steering.autopilot.target.headingMagnetic 95)
check "target heading 95 -> 200 ($r)" '[[ "$r" == 200* ]]'
sleep 1.5
check "set course is 95 ($(deg steering.autopilot.target.headingMagnetic))" \
  '[[ "$(deg steering.autopilot.target.headingMagnetic)" == 95 ]]'

r=$(curl -s "${AUTH[@]}" "$BASE/signalk/v2/api/vessels/self/autopilots/_default" | jq -r .state)
check "V2 API state is auto ($r)" '[[ "$r" == auto ]]'

r=$(put steering.autopilot.state '"standby"')
check "PUT state standby -> 200 ($r)" '[[ "$r" == 200* ]]'
check "state is standby" 'wait_for steering.autopilot.state "\"standby\"" 5'

r=$(put steering.autopilot.actions.adjustHeading 5)
check "plugin refuses adjust in standby ($r)" '[[ "$r" == 400*"not engaged"* ]]'
r=$(put steering.autopilot.ac10.steps 5)
check "firmware refuses steps in standby, bypassing the plugin ($r)" '[[ "$r" == 400*"rudder"* ]]'

r=$(curl -s -X POST "${AUTH[@]}" "$BASE/signalk/v2/api/vessels/self/autopilots/_default/engage" | jq -r .statusCode)
check "V2 engage -> 200 ($r)" '[[ "$r" == 200 ]]'
check "state is auto again" 'wait_for steering.autopilot.state "\"auto\"" 5'

check "no rudder movement in standby (NFU violations $(value test.ac10sim.nfuViolations))" \
  '[[ "$(value test.ac10sim.nfuViolations)" == 0 ]]'

r=$(put steering.autopilot.actions.adjustHeading 30)
check "adjustHeading +30 -> 200 ($r)" '[[ "$r" == 200* ]]'
sleep 0.5
r=$(put test.ac10sim.headStandby true)
check "STANDBY on the control head during the course change -> 200 ($r)" '[[ "$r" == 200* ]]'
check "state is standby" 'wait_for steering.autopilot.state "\"standby\"" 5'
sleep 2

# A press already under way when the AC10 drops to STANDBY is unavoidable: allow one
check "steps stop when STANDBY is pressed on the head (NFU violations $(value test.ac10sim.nfuViolations), max 1)" \
  '(( $(value test.ac10sim.nfuViolations) <= 1 ))'

kill $DEV
check "device gone: state unknown" 'wait_for steering.autopilot.state null 12'
check "remoteOffline alarm" \
  '[[ "$(value notifications.autopilot.remoteOffline | jq -r .state)" == alarm ]]'
r=$(put steering.autopilot.state '"standby"')
check "commands refused while offline ($r)" '[[ "$r" == 400*"not connected"* ]]'

if [[ $fail -ne 0 ]]; then
  echo "--- device log"; tail -40 "$WORK/device.log"
  echo "--- server log"; grep -i -E "ac10|error" "$WORK/server.log" | tail -30
  exit 1
fi
echo "all AC10 end-to-end checks passed"
