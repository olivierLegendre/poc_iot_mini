# DRAGINO_T68DL

## Device

- Product: Dragino T68DL (LoRaWAN periodic temperature / humidity sensor)
- Role in this PoC: first LoRaWAN end-device used to extend runbook step `F4`
- Validation scope in this guide: `F4` with one sensor (`dragino_t68dl_01`) before scaling to two sensors

## Goal of this guide

Register one periodic LoRaWAN sensor in ChirpStack (OTAA), confirm join success, capture uplinks on MQTT, and generate cadence evidence.

## Sources

- Runbook: `poc_project_runbook_ubuntu_EN.md` (`F4`)
- Gateway setup dependency: `devices/lora/wisgate_edge_lite_2/README.md` (`F1`, `F2`, `F3`)
- Dragino product page:
  `https://www.dragino.com/products/temperature-humidity-sensor/item/352-t68dl.html`

## Prerequisites

- `F1`, `F2`, and `F3` completed
- Gateway is online in ChirpStack
- Stack is healthy:

```bash
cd ~/Public/poc/stack
docker compose ps
docker logs --tail 120 chirpstack
docker logs --tail 120 chirpstack-gateway-bridge
```

- MQTT admin credentials exist in `stack/.env` (`MQTT_ADMIN_USER`, `MQTT_ADMIN_PASS`)
- You have the sensor provisioning values ready:
  - `DEV_EUI`
  - `JOIN_EUI` (AppEUI)
  - `APP_KEY`

----------------------------------------------

## Step-by-step for F4 (single periodic sensor)

### 1) Start MQTT capture for join/uplink events (terminal A)

```bash
source ~/Public/poc/stack/.env
mosquitto_sub -h localhost -u "$MQTT_ADMIN_USER" -P "$MQTT_ADMIN_PASS" \
  -t 'application/+/device/+/event/join' \
  -t 'application/+/device/+/event/up' -v \
  | tee ~/Public/poc/evidence/logs/F4_dragino_t68dl_mqtt.txt
```

### 2) Create or verify LoRaWAN profile/app in ChirpStack

In ChirpStack UI (`http://localhost:8080`):

If no profile exists yet, create one:

- Go to `Tenant -> Device profiles -> Add device profile`
- Name: `dragino_t68dl_eu868_class_a`
- Region / Region common name: `EU868`
- Class support: `Class A` only (disable Class B / Class C options if enabled)
- OTAA: keep OTAA flow enabled in the profile if the UI exposes this field
- Save

Then ensure you have an application:

- Go to `Tenant -> Applications`
- Use existing application or create one (example used in this PoC: `lorawan_sensors_poc`)

### 3) Add device `dragino_t68dl_01`

In ChirpStack UI:

- Name: `dragino_t68dl_01`
- Device EUI: `<DEV_EUI>` (A84041206F5B665E)
- Join EUI: `<JOIN_EUI>`(A840410000000100)
- AppKey: `<APP_KEY>` (E74A5B25556B16CCFE8A8E0715058FB2)
- Device profile: the EU868 OTAA profile from step 2

### 4) Trigger join from the physical sensor

- Power/reboot the sensor or use its join button sequence from vendor instructions (5s press)
- Keep sensor close to the gateway during first join

### 5) Confirm join and first uplink evidence

Keep MQTT capture running, then extract proof lines:

```bash
export DEV_EUI_LOWER="<replace_with_lowercase_deveui>"
rg -n "event/join|event/up|${DEV_EUI_LOWER}|dragino_t68dl_01" \
  ~/Public/poc/evidence/logs/F4_dragino_t68dl_mqtt.txt \
  | tee ~/Public/poc/evidence/logs/F4_dragino_t68dl_join_proof.txt
```

Important:

- `F4_dragino_t68dl_join_proof.txt` is created on demand by `tee`
- `F4_dragino_t68dl_mqtt.txt` must already exist (step 1)

### 6) Validate data sent to Mosquitto (device uplinks)

Observe only uplink payloads and keep a timestamped log (terminal B):

```bash
source ~/Public/poc/stack/.env
mosquitto_sub -h localhost -u "$MQTT_ADMIN_USER" -P "$MQTT_ADMIN_PASS" \
  -t 'application/+/device/+/event/up' -v \
| while IFS= read -r line; do
    printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$line"
  done \
| tee ~/Public/poc/evidence/logs/F4_dragino_t68dl_mqtt_ts.txt
```

Expected:

- Recurrent messages for the device topic `application/<app_id>/device/<dev_eui>/event/up`
- Payload contains at least LoRaWAN metadata fields (`fPort/fCnt` variants), and optionally decoded `object` fields (for example temperature / humidity) if a codec is configured

### 7) Record cadence table (CSV, auto-generated)

```bash
LOG=~/Public/poc/evidence/logs/F4_dragino_t68dl_mqtt_ts.txt
OUT=~/Public/poc/evidence/exports/F4_dragino_t68dl_uplinks.csv

awk '
BEGIN {
  OFS=",";
  print "sample_id,device_eui,observed_ts_utc,f_port,f_cnt,interval_since_prev_s,notes";
}
function extract_num(payload, key1, key2,    re, v) {
  v="na";
  re="\\\"" key1 "\\\":[[:space:]]*[-0-9.]+";
  if (match(payload, re)) {
    v=substr(payload, RSTART, RLENGTH);
    sub(/.*:/, "", v);
    gsub(/[[:space:]]/, "", v);
    return v;
  }
  if (key2!="") {
    re="\\\"" key2 "\\\":[[:space:]]*[-0-9.]+";
    if (match(payload, re)) {
      v=substr(payload, RSTART, RLENGTH);
      sub(/.*:/, "", v);
      gsub(/[[:space:]]/, "", v);
      return v;
    }
  }
  return v;
}
{
  ts=$1;
  topic=$2;
  payload=substr($0, index($0, $3));

  split(topic, t, "/");
  if (t[1]!="application" || t[3]!="device" || t[5]!="event" || t[6]!="up") next;
  dev_eui=t[4];

  f_port=extract_num(payload, "fPort", "f_port");
  f_cnt=extract_num(payload, "fCnt", "f_cnt");

  cmd="date -u -d \"" ts "\" +%s";
  cmd | getline epoch;
  close(cmd);

  interval="na";
  if (dev_eui in prev_epoch && epoch>0) {
    interval=epoch-prev_epoch[dev_eui];
  }
  if (epoch>0) {
    prev_epoch[dev_eui]=epoch;
  }

  sample_id++;
  print sample_id, dev_eui, ts, f_port, f_cnt, interval, "uplink";
}
' "$LOG" > "$OUT"
```

### 8) Optional quick summary check

```bash
awk -F, 'NR>1 {n++; if ($6!="na") {sum+=$6; k++}} END {printf "samples=%d avg_interval_s=%s\n", n, (k?sum/k:"na")}' \
  ~/Public/poc/evidence/exports/F4_dragino_t68dl_uplinks.csv
```

## F4 pass criteria for this first sensor

- `dragino_t68dl_01` joins successfully (join event captured)
- At least one valid uplink is received on MQTT
- Periodic uplinks are visible over an observation window and exported to CSV
- Evidence files exist:
  - `evidence/logs/F4_dragino_t68dl_mqtt.txt`
  - `evidence/logs/F4_dragino_t68dl_join_proof.txt`
  - `evidence/logs/F4_dragino_t68dl_mqtt_ts.txt`
  - `evidence/exports/F4_dragino_t68dl_uplinks.csv`

## Troubleshooting

- Device never joins:
  - verify `DEV_EUI`, `JOIN_EUI`, and `APP_KEY`
  - confirm gateway is online and region is `EU868`
  - trigger a new OTAA join on the sensor
- MQTT capture empty:
  - verify Mosquitto credentials in `stack/.env`
  - verify topic filter uses `application/+/device/+/event/up`
- `Unknown device` in ChirpStack logs:
  - DevEUI in the uplink does not match a registered device
- `No channel found for frequency ...`:
  - align ChirpStack EU868 channel-plan as documented in `devices/lora/wisgate_edge_lite_2/README.md`
