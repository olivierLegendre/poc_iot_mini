# SONOFF_SNZB_03P

## Device

- Product: SONOFF SNZB-03P (Zigbee motion sensor)
- Reference: `SNZB-03P`
- Role in this PoC: Zigbee motion sensor used to validate onboarding + event-driven behavior in step `E2`

## Goal of this guide

Register this sensor to the existing Zigbee coordinator (`SMLIGHT SLZB-06U` via Zigbee2MQTT) and validate event-driven motion messages on MQTT.

## Sources

- SONOFF official installation/configuration guide:  
  `https://help.sonoff.tech/docs/snzb-03p`
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

- Sensor powered and physically close to coordinator for first pairing (`< 2 m` recommended)
- Detection specs (from SONOFF guide): approximately `6 m` range and `110°` angle
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
  | tee ~/Public/poc/evidence/logs/E2_sonoff_snzb_03p_mqtt.txt
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

### 4) Put sensor in pairing mode (factory reset)

For this device:

- Press and hold the pairing button for about `5 seconds`
- Confirm LED is flashing slowly (pairing mode, up to ~180 seconds)
- If no join after ~30 seconds, release and retry near coordinator

LED quick checks (from SONOFF guide):

- Slow flash: pairing mode
- On for ~3s then off: paired successfully
- Slow flash then off without join: pairing timeout/failure

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
  | tee ~/Public/poc/evidence/logs/E2_sonoff_snzb_03p_z2m_pairing.txt

# 2) Extract join/interview proof lines
rg -n "joined|interview successful|Successfully interviewed|sonoff_snzb_03p_01" \
  ~/Public/poc/evidence/logs/E2_sonoff_snzb_03p_z2m_pairing.txt \
  | tee ~/Public/poc/evidence/logs/E2_sonoff_snzb_03p_pairing_proof.txt
```

### 6) Rename the device to stable friendly name

In Zigbee2MQTT UI, rename to:

- `sonoff_snzb_03p_01`

Expected state topic:

- `zigbee2mqtt/sonoff_snzb_03p_01`

### 7) Validate data sent to Mosquitto server

Run:

```bash
source ~/Public/poc/stack/.env
mosquitto_sub -h localhost -u "$MQTT_ADMIN_USER" -P "$MQTT_ADMIN_PASS" -t 'zigbee2mqtt/sonoff_snzb_03p_01' -v \
  | tee ~/Public/poc/evidence/logs/E2_sonoff_snzb_03p_payloads.txt
```

Validation:

- Messages are received on topic `zigbee2mqtt/sonoff_snzb_03p_01`
- Payload includes expected keys:
  - `occupancy`
  - `illumination`
  - `battery`
  - `voltage`
  - `linkquality`
  - `update`
  - `update_available`

Example payload:

```json
{"battery":100,"illumination":"bright","linkquality":120,"occupancy":false,"update":{"installed_version":8705,"latest_version":8705,"state":"idle"},"update_available":false,"voltage":2800}
```

### 8) Validate event-driven behavior (E2)

Perform `N=10` controlled stimuli:

- Start from no motion for ~10 seconds
- Trigger motion in front of sensor for ~2-3 seconds
- Return to no motion
- the censor go for occupacy : false to true almost in real time, but take times to go back to false (between 1 and 3 minutes observed)
- Repeat for 10 trials with timestamps

Capture timestamped MQTT stream during trials:

```bash
source ~/Public/poc/stack/.env
mosquitto_sub -h localhost -u "$MQTT_ADMIN_USER" -P "$MQTT_ADMIN_PASS" -t 'zigbee2mqtt/sonoff_snzb_03p_01' -v \
| while IFS= read -r line; do
    printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$line"
  done \
| tee ~/Public/poc/evidence/logs/E2_sonoff_snzb_03p_mqtt_ts.txt
```

Expected behavior:

- Motion trigger publishes `occupancy: true`
- Clear state publishes `occupancy: false` after device timeout

Optional communication-distance check:

- Short-press the device button after placement
- LED flashes twice quickly means it is online and in effective Zigbee range

### 9) Record E2 trial table (CSV)

Option A (recommended): auto-generate trial CSV from MQTT trial log.

```bash
LOG=~/Public/poc/evidence/logs/E2_sonoff_snzb_03p_mqtt_ts.txt
OUT=~/Public/poc/evidence/exports/E2_sonoff_snzb_03p_trials.csv

awk '
BEGIN {
  OFS=",";
  print "trial_id,stimulus_ts_utc,stimulus_type,expected_event,observed_event,observed_ts_utc,latency_ms,duplicate_count,notes";
}
$2=="zigbee2mqtt/sonoff_snzb_03p_01" {
  ts=$1;
  payload=substr($0, index($0, $3));

  occ="";
  if (payload ~ /"occupancy":[[:space:]]*true/) {
    occ="true";
  } else if (payload ~ /"occupancy":[[:space:]]*false/) {
    occ="false";
  } else {
    next;
  }

  battery="na";
  linkquality="na";
  if (match(payload, /"battery":[[:space:]]*[0-9]+/)) {
    tmp=substr(payload, RSTART, RLENGTH);
    sub(/.*:/, "", tmp);
    gsub(/[[:space:]]/, "", tmp);
    battery=tmp;
  }
  if (match(payload, /"linkquality":[[:space:]]*[0-9]+/)) {
    tmp=substr(payload, RSTART, RLENGTH);
    sub(/.*:/, "", tmp);
    gsub(/[[:space:]]/, "", tmp);
    linkquality=tmp;
  }

  if (occ=="true") {
    if (in_motion==0) {
      trial_id++;
      in_motion=1;
      dup[trial_id]=0;
      trial_ts[trial_id]=ts;
      trial_note[trial_id]="battery=" battery ";linkquality=" linkquality;
    } else {
      dup[trial_id]++;
    }
  } else if (occ=="false") {
    in_motion=0;
  }
}
END {
  for (i=1; i<=trial_id; i++) {
    print i, trial_ts[i], "motion_trigger", "occupancy:true", "occupancy:true", trial_ts[i], 0, dup[i], trial_note[i];
  }
}
' "$LOG" > "$OUT"
```

Notes:

- It uses `observed_ts_utc` as proxy for `stimulus_ts_utc` and sets `latency_ms=0`.
- If you recorded manual stimulus timestamps separately, replace `stimulus_ts_utc` and recompute `latency_ms`.

## Pass criteria for this onboarding attempt

- Device successfully joins Zigbee network
- Friendly topic `zigbee2mqtt/sonoff_snzb_03p_01` exists
- For `N=10` trials, expected motion events are observed
- No unexplained duplicates

## Troubleshooting

- No join logs: re-enable permit join, keep sensor closer to coordinator, retry pairing
- Interview fails: retry 2-3 times and keep sensor active during interview
- No motion events: confirm battery level and clear line of sight, then retry trials
