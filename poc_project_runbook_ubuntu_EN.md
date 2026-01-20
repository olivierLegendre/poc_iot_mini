# IoT PoC Project Runbook (Ubuntu host)

*Version date: 2026-01-20 (Europe/Paris)*

## Scope

This project is a **minimum viable industrial/building IoT PoC** proving multi-network onboarding and control using:

- **Zigbee** via **SMLIGHT SLZB-06** (LAN) + **Zigbee2MQTT**
- **LoRaWAN EU868** via **RAK WisGate Edge Lite 2 V2** in **LoRa Basics Station** mode
- **MQTT** as the backbone (Mosquitto)
- **ChirpStack v4** + **ChirpStack Gateway Bridge** (Basics Station backend)
- **PostgreSQL** (single DB: ChirpStack + `poc.*` schema)
- **Node-RED** + **FlowFuse Dashboard** for UI, registry, ingestion, and scenario logic

## Acceptance criteria (PoC is 'functional' when)

- ≥ 2 Zigbee sensors + ≥ 1 Zigbee actuator are onboarded and uniquely identified.
- ≥ 2 LoRaWAN sensors + ≥ 1 LoRaWAN actuator (TRV) are onboarded and uniquely identified (EU868).
- All telemetry reaches **one MQTT broker** and is stored in **PostgreSQL** with timestamps.
- UI supports: device registry, latest values, historical view, manual actuation.
- Automation: ≥ 2 deterministic scenarios executed and auditable.
- LoRaWAN downlink success: **confirmed by the device**, plus physical observation when feasible.

## Project folder layout (recommended)

```text
poc/
  stack/                # docker-compose + configs
  scripts/              # helper scripts
  evidence/             # sponsor-grade evidence
    photos/
    screenshots/
    logs/
    configs/
    exports/
  docs/
```

## Evidence protocol (scientific)

For every step:
1) Perform the **Action**
2) Run the **Test/Pass** immediately
3) Save **Proof/Evidence** (logs, screenshots, photos, exports) under `evidence/`

Use step IDs (A1, A2, …) as filenames or prefixes so evidence is traceable.

## Known complexities / do-not-guess areas

- **LoRaWAN TRV payloads** are device/vendor-specific: derive payload bytes from vendor docs/codec; do not invent.
- **Basics Station + TLS** requires the server certificate SAN to match exactly the hostname/IP used in the gateway `wss://HOST:PORT` URI.
- **LoRaWAN Class A** downlinks happen after an uplink (RX1/RX2). Confirmation may only appear on subsequent traffic; plan for latency.

## Prerequisites

- Ubuntu 22.04/24.04 LTS host with sudo access
- Network: Ubuntu host + SLZB-06 + RAK gateway on the same LAN; DHCP reservations recommended
- Internet access for pulling Docker images

## Execution steps (follow in order)

### A1 — Host baseline + workspace

**Reminder**

Create a deterministic workspace on Ubuntu and capture the environment versions.

**Documentation**

- Ubuntu: timedatectl / timezone settings
- Project evidence method (folder tree)

**Action**

- Set timezone Europe/Paris
- Create folders: `~/poc/{stack,scripts,evidence/{photos,screenshots,logs,configs,exports},docs}`
- Save environment outputs into `evidence/logs/`

**Test / Pass**

- Timezone correct; folders exist and are writable

**Proof / Evidence**

- Store `uname -a`, `lsb_release -a`, `timedatectl` outputs in evidence/logs

**Commands**

```bash
timedatectl set-timezone Europe/Paris
mkdir -p ~/poc/{stack,scripts,evidence/{photos,screenshots,logs,configs,exports},docs}
uname -a | tee ~/poc/evidence/logs/A1_uname.txt
lsb_release -a | tee ~/poc/evidence/logs/A1_lsb_release.txt
timedatectl | tee ~/poc/evidence/logs/A1_timedatectl.txt
```

### A2 — LAN readiness (SLZB-06 + RAK gateway)

**Reminder**

Your coordinator and gateway must be reachable with stable IPs before any software work.

**Documentation**

- Router DHCP reservations / static leases
- RAK WisGate UI (WisGateOS) for EUI / region / Basics Station
- SMLIGHT SLZB-06 web UI for firmware/mode

**Action**

- Connect Ubuntu host, SLZB-06, and RAK gateway to the same switch/LAN
- Create DHCP reservations for both devices (recommended)
- Record IPs + firmware versions in `evidence/configs/inventory.md`

**Test / Pass**

- Both devices answer ping and remain stable after reboot/power cycle

**Proof / Evidence**

- Screenshots of DHCP reservations + ping output saved

**Commands**

```bash
ping -c 3 <SLZB06_IP> | tee ~/poc/evidence/logs/A2_ping_slzb06.txt
ping -c 3 <RAK_GW_IP> | tee ~/poc/evidence/logs/A2_ping_rakgw.txt
```

### B1 — Install Docker Engine + Compose

**Reminder**

All PoC services run in Docker. The goal is a reproducible container runtime.

**Documentation**

- Docker Engine install (official repository) + Compose v2 plugin

**Action**

- Install Docker Engine and Compose plugin
- Add user to `docker` group (or use sudo)

**Test / Pass**

- `docker run --rm hello-world` succeeds

**Proof / Evidence**

- Save docker versions + hello-world output

**Commands**

```bash
docker --version | tee ~/poc/evidence/logs/B1_docker_version.txt
docker compose version | tee ~/poc/evidence/logs/B1_docker_compose_version.txt
docker run --rm hello-world | tee ~/poc/evidence/logs/B1_hello_world.txt
```

### C1 — Create stack configs (.env, Mosquitto, Postgres init, Z2M, ChirpStack, Gateway Bridge)

**Reminder**

You are defining the reproducible infrastructure: security + persistence + repeatability.

**Documentation**

- Mosquitto auth + ACL concepts
- ChirpStack + Gateway Bridge config concepts
- Zigbee2MQTT TCP adapter for SLZB-06

**Action**

- Create `stack/docker-compose.yml` and config files
- Create `stack/.env` from `.env.example` and set strong secrets
- Run `docker compose config` to validate

**Test / Pass**

- Compose validation succeeds with no errors

**Proof / Evidence**

- Save the validated compose output to evidence/logs

**Commands**

```bash
cd ~/poc/stack
docker compose config | tee ~/poc/evidence/logs/C1_compose_config.txt
```

**Note:** If you already have a working stack from previous iterations, keep it. This project runbook focuses on *how to execute*, not forcing a new compose format.

### C2 — Start the stack + validate UIs + restart persistence

**Reminder**

This proves the software platform is stable before onboarding devices.

**Documentation**

- Docker Compose lifecycle: up/down/logs

**Action**

- Start stack: `docker compose up -d`
- Open UIs: Zigbee2MQTT (8081), Node-RED (1880), ChirpStack (8080)
- Restart the stack and confirm the UIs and config persist

**Test / Pass**

- All containers are healthy; UIs reachable before and after restart

**Proof / Evidence**

- Save `docker ps` and logs

**Commands**

```bash
cd ~/poc/stack
docker compose up -d
docker ps | tee ~/poc/evidence/logs/C2_docker_ps.txt
docker compose logs --no-color > ~/poc/evidence/logs/C2_compose_logs.txt

# Restart test
docker compose restart
docker ps | tee ~/poc/evidence/logs/C2_docker_ps_after_restart.txt
```

### D1 — Zigbee backbone: configure Zigbee2MQTT to SLZB-06 over LAN

**Reminder**

Freeze Zigbee channel and PAN IDs BEFORE pairing devices.

**Documentation**

- Zigbee2MQTT configuration.yaml (serial TCP, advanced channel/pan)

**Action**

- Edit `stack/zigbee2mqtt/configuration.yaml` to set SLZB-06 TCP endpoint
- Set `advanced.channel`, `pan_id`, `ext_pan_id` explicitly
- Start Zigbee2MQTT and verify stable startup; restart once

**Test / Pass**

- Z2M initializes coordinator; no reconnect loop; parameters persist

**Proof / Evidence**

- Save config + Z2M logs

**Commands**

```bash
# Save the config as evidence
cp ~/poc/stack/zigbee2mqtt/configuration.yaml ~/poc/evidence/configs/D1_z2m_configuration.yaml

# Logs
docker logs --tail 200 zigbee2mqtt | tee ~/poc/evidence/logs/D1_z2m_startup.txt
docker restart zigbee2mqtt
docker logs --tail 200 zigbee2mqtt | tee ~/poc/evidence/logs/D1_z2m_after_restart.txt
```

### E1 — Pair Zigbee periodic sensor #1 and prove cadence

**Reminder**

Use a controlled pairing window and record the reset/join procedure.

**Documentation**

- Device vendor reset/join procedure
- Zigbee2MQTT permit_join + naming

**Action**

- Enable permit_join for 5 minutes in Zigbee2MQTT UI
- Factory reset the sensor and join it; assign a friendly name
- Capture MQTT for 20+ minutes

**Test / Pass**

- Messages arrive at expected interval

**Proof / Evidence**

- UI screenshot + MQTT transcript + notes of expected interval

**Commands**

```bash
mosquitto_sub -h localhost -t 'zigbee2mqtt/#' -v | tee ~/poc/evidence/logs/E1_zigbee_sensor1_mqtt.txt
```

### E2 — Pair Zigbee event-driven sensor and run N trials

**Reminder**

Event-driven testing must be controlled: N stimuli, N expected events.

**Documentation**

- Trial table method (miss/duplicate/latency)

**Action**

- Pair an event-driven sensor (contact/motion/button)
- Perform N stimuli (e.g., 10 open/close cycles) with timestamps
- Save results table (CSV) in evidence/exports

**Test / Pass**

- All N events observed; no duplicates

**Proof / Evidence**

- MQTT transcript + trial CSV

**Commands**

```bash
# MQTT capture (run during trials)
mosquitto_sub -h localhost -t 'zigbee2mqtt/#' -v | tee ~/poc/evidence/logs/E2_zigbee_event_trials_mqtt.txt
```

### E3 — Pair Zigbee actuator and validate ON/OFF

**Reminder**

Choose an actuator with clear physical feedback (LED/relay click).

**Documentation**

- Zigbee2MQTT set commands (`.../set`)

**Action**

- Pair the actuator (smart plug/relay) and name it
- Publish ON then OFF commands
- Record physical observation (video/photo) and MQTT state feedback

**Test / Pass**

- Actuator changes state; state is reflected in MQTT/UI

**Proof / Evidence**

- Video/photo + MQTT transcript

**Commands**

```bash
mosquitto_pub -h localhost -t 'zigbee2mqtt/<ACTUATOR_NAME>/set' -m '{"state":"ON"}'
sleep 2
mosquitto_pub -h localhost -t 'zigbee2mqtt/<ACTUATOR_NAME>/set' -m '{"state":"OFF"}'
```

### F1 — Enable Basics Station LNS (wss) on the server + generate TLS

**Reminder**

TLS server authentication must be correct before touching the gateway configuration.

**Documentation**

- ChirpStack Gateway Bridge: basics_station backend + bind port
- TLS: CA + server cert SAN must match wss host

**Action**

- Choose the host for the gateway LNS URI (DNS name or fixed LAN IP)
- Generate CA + server cert/key with SAN including that host
- Configure Gateway Bridge with `bind=:3000` and TLS cert/key paths; restart it

**Test / Pass**

- Gateway Bridge starts; no TLS errors; LNS listener is up

**Proof / Evidence**

- Save cert CA (public) + Gateway Bridge logs + config extract

**Commands**

```bash
docker logs --tail 200 chirpstack-gateway-bridge | tee ~/poc/evidence/logs/F1_gwbridge_logs.txt
```

### F2 — Configure RAK WisGate Edge Lite 2 V2 (EU868, Basics Station, LNS-only)

**Reminder**

This is mostly a gateway UI task: set EU868, Basics Station, wss LNS URI, import CA, keep CUPS empty.

**Documentation**

- WisGateOS: Gateway EUI, region/channel-plan, Basics Station settings

**Action**

- Set region/channel-plan to EU868
- Enable Basics Station mode
- Set LNS Server to `wss://<HOST>:3000`
- Disable / leave CUPS empty (LNS-only)
- Import the CA certificate into the gateway trust store

**Test / Pass**

- Gateway shows connected; ChirpStack sees gateway online

**Proof / Evidence**

- Screenshots: EU868, LNS URI, CA import, connected status

### F3 — Register gateway in ChirpStack and prove online/last-seen

**Reminder**

ChirpStack must know the Gateway EUI and show online status.

**Documentation**

- ChirpStack UI: add gateway, check last seen

**Action**

- Add gateway using the exact Gateway EUI
- Reboot gateway once and measure reconnection time

**Test / Pass**

- Gateway stays online; reconnection within documented window

**Proof / Evidence**

- Screenshot before/after reboot + log timestamps

**Commands**

```bash
docker logs --tail 200 chirpstack-gateway-bridge | tee ~/poc/evidence/logs/F3_gwbridge_reconnect.txt
```

### F4 — OTAA join LoRaWAN sensors (2) and capture MQTT uplinks

**Reminder**

Prove joins and uplinks for two distinct DevEUIs. Keep AppKeys secure.

**Documentation**

- ChirpStack UI: device profiles (EU868), application, devices
- MQTT topics: `application/+/device/+/event/up`

**Action**

- Create device profile (EU868), application, device #1 and device #2 (DevEUI/AppKey)
- Trigger join; verify join-accept and first uplink
- Capture MQTT uplinks for both devices

**Test / Pass**

- Both devices join and send at least one uplink each

**Proof / Evidence**

- ChirpStack screenshots + MQTT transcript saved

**Commands**

```bash
mosquitto_sub -h localhost -t 'application/+/device/+/event/up' -v | tee ~/poc/evidence/logs/F4_lorawan_uplinks_mqtt.txt
```

### F5 — Confirmed downlink to LoRaWAN TRV (device-confirmed + physical observation if feasible)

**Reminder**

Do not label a command as successful until you have device confirmation evidence. TRV payload must come from vendor docs.

**Documentation**

- ChirpStack: queue downlink (confirmed), inspect downlink status
- TRV vendor codec documentation (payload derivation)

**Action**

- Derive payload bytes deterministically from vendor docs; store derivation in evidence/configs
- Queue a confirmed downlink (fPort + base64 payload)
- Wait for device uplink (Class A) and confirm acknowledgement evidence
- Record physical observation (photo/video) if feasible
- Negative control: send an invalid payload once and confirm it is NOT confirmed

**Test / Pass**

- Confirmed downlink acknowledged by device; invalid downlink not falsely confirmed

**Proof / Evidence**

- Screenshots of queue + event logs + observation media + (optional) DB rows

### G1 — Application DB schema + registry rules

**Reminder**

Define canonical IDs: Zigbee IEEE address; LoRaWAN DevEUI. Upsert rules prevent duplicates.

**Documentation**

- PostgreSQL: schema + JSONB patterns

**Action**

- Create `poc.*` schema and tables (or run init scripts in Postgres container)
- Define normalization rules (what goes into `metrics`)

**Test / Pass**

- Tables exist; unique constraint works; a rename does not create duplicate device

**Proof / Evidence**

- SQL output (`\dn`, `\dt poc.*`) saved

**Commands**

```bash
psql -h localhost -U <PG_USER> -d <PG_DB> -c "\dn" | tee ~/poc/evidence/logs/G1_psql_schemas.txt
psql -h localhost -U <PG_USER> -d <PG_DB> -c "\dt poc.*" | tee ~/poc/evidence/logs/G1_psql_tables.txt
```

**Code / Config**

```sql
-- Minimal PoC tables (example)
CREATE SCHEMA IF NOT EXISTS poc;

CREATE TABLE IF NOT EXISTS poc.devices (
  id BIGSERIAL PRIMARY KEY,
  network TEXT NOT NULL CHECK (network IN ('zigbee','lorawan')),
  external_id TEXT NOT NULL,
  display_name TEXT,
  meta JSONB DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ DEFAULT now(),
  last_seen_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS devices_unique ON poc.devices(network, external_id);

CREATE TABLE IF NOT EXISTS poc.telemetry (
  id BIGSERIAL PRIMARY KEY,
  device_id BIGINT REFERENCES poc.devices(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_topic TEXT
);

CREATE TABLE IF NOT EXISTS poc.commands (
  id BIGSERIAL PRIMARY KEY,
  network TEXT NOT NULL CHECK (network IN ('zigbee','lorawan')),
  device_id BIGINT REFERENCES poc.devices(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  command JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','transmitted','confirmed','observed','failed')),
  status_detail TEXT
);
```

### G2 — Node-RED ingestion flows (MQTT → PostgreSQL)

**Reminder**

This is the 'digital spine': all telemetry is captured, timestamped, and queryable.

**Documentation**

- Node-RED MQTT nodes; PostgreSQL node; FlowFuse Dashboard nodes

**Action**

- Subscribe to `zigbee2mqtt/#` and `application/+/device/+/event/up`
- Write to PostgreSQL: upsert device, insert telemetry
- Validate with at least 3 messages from a Zigbee and a LoRa device

**Test / Pass**

- Telemetry rows appear in DB within seconds of MQTT receipt

**Proof / Evidence**

- Saved flow export JSON + DB extracts

**Commands**

```bash
# Watch both inputs on MQTT while generating messages
mosquitto_sub -h localhost -t 'zigbee2mqtt/#' -v | tee ~/poc/evidence/logs/G2_watch_zigbee.txt
# in another terminal:
mosquitto_sub -h localhost -t 'application/+/device/+/event/up' -v | tee ~/poc/evidence/logs/G2_watch_lora.txt
```

**Code / Config**

```javascript
// Node-RED Function node idea (pseudo):
// - Identify device from topic/payload
// - Upsert into poc.devices
// - Insert raw + metrics into poc.telemetry
// Keep raw for audit; normalize metrics for dashboards/scenarios.
```

### G3 — FlowFuse Dashboard UI (device list, last-seen, latest values)

**Reminder**

Sponsors need a clear UI. Keep it minimal, truthful, and stable across restarts.

**Documentation**

- Dashboard components (tables, tiles, charts)

**Action**

- Create a device list view (from `poc.devices`)
- Create a latest telemetry view (from `poc.latest_telemetry` view or query)
- Add one chart (e.g., temperature last 1h)
- Restart Node-RED container and prove persistence

**Test / Pass**

- UI shows live values and history; survives restart

**Proof / Evidence**

- Screenshots + short screen recording + restart evidence

**Commands**

```bash
docker restart nodered
docker logs --tail 200 nodered | tee ~/poc/evidence/logs/G3_nodered_restart.txt
```

### G4 — Manual control + truthful command state tracking

**Reminder**

Zigbee can often confirm quickly; LoRaWAN requires device confirmation and may be delayed (Class A).

**Documentation**

- Command state machine: queued/transmitted/confirmed/observed/failed

**Action**

- Zigbee: publish to `zigbee2mqtt/<device>/set` and record state feedback
- LoRaWAN: queue confirmed downlink and only mark confirmed when device evidence exists
- Write each command into `poc.commands` with timestamps and status transitions

**Test / Pass**

- No false 'confirmed' states; DB shows correct lifecycle for 1 Zigbee and 1 LoRa command

**Proof / Evidence**

- DB export of `poc.commands` rows + screenshots/logs

### H1 — Scenario 1 (Zigbee): threshold + hysteresis + cooldown

**Reminder**

Test first with simulation, then with real sensor input. Ensure deterministic behavior.

**Documentation**

- Node-RED scenario design patterns (hysteresis, debounce, cooldown)

**Action**

- Simulate a sensor with inject nodes; validate scenario transitions
- Connect scenario input to real Zigbee sensor; output to Zigbee actuator
- Log every trigger and action in DB

**Test / Pass**

- Scenario triggers exactly as defined; no thrash; action logged

**Proof / Evidence**

- Timeline export + DB action log + screenshots

### H2 — Scenario 2 (multi-network): event → LoRaWAN command + manual override

**Reminder**

Demonstrate multi-network orchestration and safe override behavior.

**Documentation**

- Override pattern: operator control blocks automation

**Action**

- Implement override toggle in UI
- When override active, scenario must not send downlinks
- When override inactive, scenario queues downlink and tracks confirmation

**Test / Pass**

- Override works; downlink attempts are traceable and truthful

**Proof / Evidence**

- DB exports + ChirpStack evidence + observation when feasible

### I1 — Reliability metrics (delivery + latency) + sponsor evidence bundle

**Reminder**

Produce measurable results: delivery rate, event capture rate, segmented latency (especially LoRa).

**Documentation**

- Metric definitions: received/expected; trials; segmented latency

**Action**

- Compute periodic delivery rate over a fixed window
- Compute event capture metrics from trial table
- Measure command latency segments (Zigbee and LoRa)
- Package evidence folder and compute checksums

**Test / Pass**

- Metrics tables exist and are explained; evidence bundle is complete and verifiable

**Proof / Evidence**

- CSV exports + checksum file + short narrative summary

**Commands**

```bash
cd ~/poc
tar -czf evidence_bundle.tgz evidence/
sha256sum evidence_bundle.tgz > evidence_bundle.tgz.sha256
ls -lah evidence_bundle.tgz evidence_bundle.tgz.sha256 | tee evidence/logs/I1_bundle_ls.txt
```

## Checkpoint / rollback (recommended)

At each functional milestone, create a checkpoint:
- `pg_dump` of the PostgreSQL DB
- tar backups of Docker volumes (pg-data, nodered-data, mosquitto-data)
- tar backup of `stack/zigbee2mqtt/` (paired devices)

