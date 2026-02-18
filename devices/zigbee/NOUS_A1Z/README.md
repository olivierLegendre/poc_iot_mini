# NOUS_A1Z

## Device

- Product: NOUS A1Z (Zigbee smart plug with power metering)
- Reference: `A1Z`
- Role in this PoC: Zigbee actuator used to validate onboarding + ON/OFF control in step `E3`

## Goal of this guide

Register this actuator to the existing Zigbee coordinator (`SMLIGHT SLZB-06U` via Zigbee2MQTT), validate ON/OFF control through MQTT, and collect state + metering evidence.

## Sources

- Zigbee2MQTT device page:
  `https://www.zigbee2mqtt.io/devices/A1Z.html`
- Vendor product/manual page:
  `https://nous.technology/product/a1z-1.html?show=manual`
- Zigbee2MQTT pairing guide:
  `https://www.zigbee2mqtt.io/guide/usage/pairing_devices.html`

## Prerequisites

- `D1` completed and Zigbee2MQTT healthy
- Coordinator up and reachable
- Zigbee2MQTT service running:

```bash
cd ~/Public/poc/stack
docker compose ps
docker logs --tail 100 zigbee2mqtt
```

- Plug powered and physically close to coordinator for first pairing (`< 2 m` recommended)
- If `.env` Zigbee parameters were changed, re-render and restart before onboarding:

```bash
cd ~/Public/poc
bash scripts/15_render_configs.sh
cd ~/Public/poc/stack
docker compose up -d zigbee2mqtt
docker logs --tail 100 zigbee2mqtt
```

## Step-by-step onboarding to coordinator

### 1) Start MQTT capture (terminal A)

Keep this running during pairing and validation:

```bash
source ~/Public/poc/stack/.env
mosquitto_sub -h localhost -u "$MQTT_ADMIN_USER" -P "$MQTT_ADMIN_PASS" -t 'zigbee2mqtt/#' -v \
  | tee ~/Public/poc/evidence/logs/E3_nous_a1z_mqtt.txt
```

### 2) Start Zigbee2MQTT log tail (terminal B)

```bash
docker logs --tail 200 -f zigbee2mqtt
```

### 3) Enable permit join

Use Zigbee2MQTT frontend:

- Open Zigbee2MQTT UI: `http://localhost:8081`
- Click `Permit join (All)` and confirm the timer starts

Or via MQTT:

```bash
source ~/Public/poc/stack/.env
mosquitto_pub -h localhost -u "$MQTT_ADMIN_USER" -P "$MQTT_ADMIN_PASS" -t 'zigbee2mqtt/bridge/request/permit_join' -m '{"value":true,"time":254}'
```

### 4) Put plug in pairing mode

For this device:

- Power the plug
- Press and hold the button for about `5 seconds` until LED starts blinking
- If no join after ~30 seconds, unplug/replug once and retry near coordinator

### 5) Confirm successful interview

In Zigbee2MQTT logs, wait for lines equivalent to:

- `device joined`
- `interview successful`

In MQTT capture, confirm bridge events appear under:

- `zigbee2mqtt/bridge/event`
- `zigbee2mqtt/bridge/devices`

To log pairing success as evidence:

```bash
# 1) Create the source log by capturing zigbee2mqtt logs
docker logs --tail 200 -f zigbee2mqtt 2>&1 \
  | tee ~/Public/poc/evidence/logs/E3_nous_a1z_z2m_pairing.txt

# 2) Extract join/interview proof lines
rg -n "joined|interview successful|Successfully interviewed|nous_a1z_01|A1Z" \
  ~/Public/poc/evidence/logs/E3_nous_a1z_z2m_pairing.txt \
  | tee ~/Public/poc/evidence/logs/E3_nous_a1z_pairing_proof.txt
```

### 6) Rename the device to stable friendly name

In Zigbee2MQTT UI, rename to:

- `nous_a1z_01`

Expected state topic:

- `zigbee2mqtt/nous_a1z_01`

### 7) Validate data sent to Mosquitto server

Run:

```bash
source ~/Public/poc/stack/.env
mosquitto_sub -h localhost -u "$MQTT_ADMIN_USER" -P "$MQTT_ADMIN_PASS" -t 'zigbee2mqtt/nous_a1z_01' -v \
  | tee ~/Public/poc/evidence/logs/E3_nous_a1z_payloads.txt
```

Validation:

- Messages are received on topic `zigbee2mqtt/nous_a1z_01`
- Payload includes expected keys:
  - `state`
  - `power`
  - `current`
  - `voltage`
  - `energy`
  - `child_lock`
  - `power_outage_memory`
  - `linkquality`

### 8) Validate ON/OFF command path (E3)

Start a timestamped capture for state + commands (terminal C):

```bash
source ~/Public/poc/stack/.env
mosquitto_sub -h localhost -u "$MQTT_ADMIN_USER" -P "$MQTT_ADMIN_PASS" \
  -t 'zigbee2mqtt/nous_a1z_01' -t 'zigbee2mqtt/nous_a1z_01/set' -v \
| while IFS= read -r line; do
    printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$line"
  done \
| tee ~/Public/poc/evidence/logs/E3_nous_a1z_mqtt_ts.txt
```

Send ON/OFF commands (terminal D):

```bash
source ~/Public/poc/stack/.env
mosquitto_pub -h localhost -u "$MQTT_ADMIN_USER" -P "$MQTT_ADMIN_PASS" -t 'zigbee2mqtt/nous_a1z_01/set' -m '{"state":"ON"}'
sleep 3
mosquitto_pub -h localhost -u "$MQTT_ADMIN_USER" -P "$MQTT_ADMIN_PASS" -t 'zigbee2mqtt/nous_a1z_01/set' -m '{"state":"OFF"}'
```

Optional: run 5 controlled ON/OFF cycles.

```bash
source ~/Public/poc/stack/.env
for i in $(seq 1 5); do
  mosquitto_pub -h localhost -u "$MQTT_ADMIN_USER" -P "$MQTT_ADMIN_PASS" -t 'zigbee2mqtt/nous_a1z_01/set' -m '{"state":"ON"}'
  sleep 2
  mosquitto_pub -h localhost -u "$MQTT_ADMIN_USER" -P "$MQTT_ADMIN_PASS" -t 'zigbee2mqtt/nous_a1z_01/set' -m '{"state":"OFF"}'
  sleep 2
done
```

Expected behavior:

- Physical feedback on plug (LED/relay) matches command
- MQTT state reflects transitions (`state: ON`, then `state: OFF`)
- With load connected, `power` should increase when `ON` and drop near `0` when `OFF`

### 9) Record E3 trial table (CSV)

Auto-generate a trial CSV from timestamped capture (`step 8`):

```bash
LOG=~/Public/poc/evidence/logs/E3_nous_a1z_mqtt_ts.txt
OUT=~/Public/poc/evidence/exports/E3_nous_a1z_trials.csv

awk '
BEGIN {
  OFS=",";
  print "trial_id,command_ts_utc,command_state,observed_state,observed_ts_utc,latency_ms,power_w,current_a,voltage_v,notes";
}
function extract_state(payload,  s) {
  s="";
  if (match(payload, /"state":"(ON|OFF)"/)) {
    s=substr(payload, RSTART, RLENGTH);
    sub(/.*:"/, "", s);
    sub(/"$/, "", s);
  }
  return s;
}
function extract_num(payload, key,    re, v) {
  re="\\\"" key "\\\":[[:space:]]*[-0-9.]+";
  v="na";
  if (match(payload, re)) {
    v=substr(payload, RSTART, RLENGTH);
    sub(/.*:/, "", v);
    gsub(/[[:space:]]/, "", v);
  }
  return v;
}
{
  ts=$1;
  topic=$2;
  payload=substr($0, index($0, $3));

  if (topic=="zigbee2mqtt/nous_a1z_01/set") {
    cmd_state=extract_state(payload);
    if (cmd_state!="") {
      trial_id++;
      pending_state=cmd_state;
      pending_ts=ts;
      pending_id=trial_id;
    }
    next;
  }

  if (topic=="zigbee2mqtt/nous_a1z_01") {
    obs_state=extract_state(payload);
    if (obs_state=="") next;

    power=extract_num(payload, "power");
    current=extract_num(payload, "current");
    voltage=extract_num(payload, "voltage");

    if (pending_id>0 && obs_state==pending_state) {
      print pending_id, pending_ts, pending_state, obs_state, ts, "na", power, current, voltage, "state_ack";
      pending_id=0;
      pending_state="";
      pending_ts="";
    } else {
      trial_id++;
      print trial_id, "", "", obs_state, ts, "na", power, current, voltage, "state_without_matching_set";
    }
  }
}
' "$LOG" > "$OUT"
```

## Pass criteria for this onboarding attempt

- Device successfully joins Zigbee network
- Friendly topic `zigbee2mqtt/nous_a1z_01` exists
- ON and OFF commands change physical actuator state
- MQTT state feedback is consistent with commands

## Troubleshooting

- No join logs: re-enable permit join, keep plug closer to coordinator, retry pairing
- Interview fails: unplug/replug the device and pair again with permit join active
- Command sent but no action: verify topic name, MQTT auth, and payload JSON format
- State changes but no metering values: connect a real AC load and retry capture
