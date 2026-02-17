# HZ_LIGHT_ZIGBEE

## Device

- Product: Haozee light sensor (Tuya Zigbee)
- Reference: `HZ-LIGHT-ZIGBEE`
- Role in this PoC: Zigbee illuminance sensor used to validate onboarding + periodic cadence in step `E1`

## Goal of this guide

Register this sensor to the existing Zigbee coordinator (`SMLIGHT SLZB-06U` via Zigbee2MQTT) and confirm we receive periodic lux data on MQTT.

## Sources

- Domadoo product page (device reference/specs):  
  `https://www.domadoo.fr/fr/produits-zigbee/7902-haozee-capteur-de-luminosite-zigbee-tuya-smart-life.html`
- Zigbee2MQTT pairing guide (permit join flow):  
  `https://www.zigbee2mqtt.io/guide/usage/pairing_devices.html`
- Tuya generic Zigbee reset guidance (when vendor manual is missing):  
  `https://support.tuya.com/en/help/_detail/Kdnct7w1tfz20`

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
  | tee ~/Public/poc/evidence/logs/E1_hz_light_zigbee_mqtt.txt
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

- Use a thin rod to press in the hole behind the device
- Wait for LED blink pattern indicating pairing mode
- If no join after ~30s, power cycle the sensor and repeat

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
  | tee ~/Public/poc/evidence/logs/E1_hz_light_zigbee_z2m_pairing.txt

# 2) Extract join/interview proof lines
rg -n "joined|interview successful|Successfully interviewed|hz_light_zigbee_01" \
  ~/Public/poc/evidence/logs/E1_hz_light_zigbee_z2m_pairing.txt \
  | tee ~/Public/poc/evidence/logs/E1_hz_light_zigbee_pairing_proof.txt
```

Important:

- `E1_hz_light_zigbee_pairing_proof.txt` is created on demand by `tee`.
- `E1_hz_light_zigbee_z2m_pairing.txt` must already exist before running `rg`.

### 6) Rename the device to stable friendly name

In Zigbee2MQTT UI, rename to:

- `hz_light_zigbee_01`

Expected state topic:

- `zigbee2mqtt/hz_light_zigbee_01`

### 7) Validate data sent to Mosquitto server

Run:

```bash
source ~/Public/poc/stack/.env
mosquitto_sub -h localhost -u "$MQTT_ADMIN_USER" -P "$MQTT_ADMIN_PASS" -t 'zigbee2mqtt/hz_light_zigbee_01' -v \
  | tee ~/Public/poc/evidence/logs/E1_hz_light_zigbee_payloads.txt
```

Validation:

- Messages are received on topic `zigbee2mqtt/hz_light_zigbee_01`
- Payload includes expected keys (`illuminance` or `illuminance_lux`, `brightness_state`, `linkquality`)

### 8) Validate periodic data reception (E1 cadence check)

Run an observation window of at least `20 minutes`:

- Keep terminal subscription running and collect periodic payloads
- Record timestamps of received messages
- Optional: do a few controlled low/high light changes to confirm payload reacts

Read data (timestamped):

```bash
source ~/Public/poc/stack/.env
mosquitto_sub -h localhost -u "$MQTT_ADMIN_USER" -P "$MQTT_ADMIN_PASS" -t 'zigbee2mqtt/hz_light_zigbee_01' -v \
| while IFS= read -r line; do
    printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$line"
  done \
| tee ~/Public/poc/evidence/logs/E1_hz_light_zigbee_mqtt_ts.txt
```

Expected payload includes at least:

- Illuminance (`illuminance` or `illuminance_lux`)
- Brightness state (`brightness_state`)
- Link quality (`linkquality`)

Note: this device listing states a change threshold; small lux variations may not publish a new message even during periodic observation.

### 9) Record cadence table (CSV)

Auto-generate from the timestamped capture file created in step `8`:

```bash
LOG=~/Public/poc/evidence/logs/E1_hz_light_zigbee_mqtt_ts.txt
OUT=~/Public/poc/evidence/exports/E1_hz_light_zigbee_cadence.csv

echo "sample_id,observed_ts_utc,illuminance_value,interval_since_prev_s,notes" > "$OUT"

i=0
prev_epoch=""
while IFS=$'\t' read -r ts payload; do
  lux=$(printf '%s\n' "$payload" | sed -nE 's/.*"illuminance_lux":[[:space:]]*([0-9.]+).*/\1/p')
  [ -z "$lux" ] && lux=$(printf '%s\n' "$payload" | sed -nE 's/.*"illuminance":[[:space:]]*([0-9.]+).*/\1/p')
  [ -z "$lux" ] && continue

  bstate=$(printf '%s\n' "$payload" | sed -nE 's/.*"brightness_state":"([^"]+)".*/\1/p')
  lq=$(printf '%s\n' "$payload" | sed -nE 's/.*"linkquality":[[:space:]]*([0-9]+).*/\1/p')

  epoch=$(date -u -d "$ts" +%s 2>/dev/null || true)
  interval=""
  if [ -n "$prev_epoch" ] && [ -n "$epoch" ]; then interval=$((epoch - prev_epoch)); fi

  i=$((i + 1))
  printf '%s,%s,%s,%s,%s\n' "$i" "$ts" "$lux" "$interval" "brightness_state=${bstate:-na};linkquality=${lq:-na}" >> "$OUT"

  [ -n "$epoch" ] && prev_epoch="$epoch"
done < <(awk '$2=="zigbee2mqtt/hz_light_zigbee_01" && NF>=3 {payload=substr($0, index($0, $3)); print $1 "\t" payload}' "$LOG")
```

## Pass criteria for this onboarding attempt

- Device successfully joins Zigbee network
- Friendly topic `zigbee2mqtt/hz_light_zigbee_01` exists
- Over `20+ minutes`, periodic messages are received with stable cadence
- No unexplained long gaps (document any expected sleep/threshold behavior)

## Troubleshooting

- No join logs: re-enable `Permit join`, keep sensor closer to coordinator, retry reset
- Interview fails: retry pairing 2-3 times, keep sensor awake during interview if button exists
- Joined but no data: increase light change amplitude (dark cover vs flashlight), wait longer between changes
- Unsupported device in log: capture `modelID` and `manufacturerName` from `zigbee2mqtt` logs for converter follow-up
