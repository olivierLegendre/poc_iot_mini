# Required PoC files (Ubuntu) — generated scaffold

This scaffold provides the **missing stack files** referenced by the runbook:
- `docker-compose.yml`
- Mosquitto config + ACL + passwordfile generation
- PostgreSQL init (poc.* schema)
- ChirpStack + Gateway Bridge config templates rendered from .env
- Zigbee2MQTT configuration template rendered from .env
- Node-RED Dockerfile + FlowFuse Dashboard + base flows.json
- Helper scripts


## Used to generate templates with adequate vars

Then:
1) `bash scripts/00_install_prereqs.sh`
2) `cp stack/.env.example stack/.env` and edit values
3) `bash scripts/15_render_configs.sh`
4) `bash scripts/20_generate_mqtt_auth.sh`
5) `bash scripts/30_generate_tls_basics_station.sh`
6) `bash scripts/35_verify_no_secrets_tracked.sh`
7) `bash scripts/40_up.sh`

Note: `init_postgres_users.sh` also applies required PostgreSQL extensions for ChirpStack (e.g., `pg_trgm`), places them in the `chirpstack` schema, and ensures the `chirpstack` role owns and can create objects in that schema (with an appropriate search_path).

## One-shot setup
You can run a single setup script from anywhere inside the repository:
`bash scripts/50_setup_all.sh`

If `.env` does not exist, the script will copy `.env.example` to `.env` and stop so you can review credentials before re-running it.

## Node-RED + FlowFuse Dashboard base flow
The Node-RED `stack/nodered/data/flows.json` file includes a base ingestion flow that:
- Subscribes to `zigbee2mqtt/#` and `application/+/device/+/event/#`.
- Normalizes messages into a single envelope.
- Upserts `poc.devices` and inserts `poc.telemetry` rows.
- Builds FlowFuse Dashboard pages with:
- **PoC activity** charts (live, record, and complete views). Defaults on load: Source = "Both", Range = "Last 1 hour".
- **All Devices**: a list of all devices that have sent data, with online/offline based on last uplink (online if seen within 1 hour).
  - **Actuators**: toggle buttons for supported actuators and a dedicated status section.
- **Event Sensors**: last 5 status changes per event sensor, with online/offline status based on last uplink.
- **Periodic Sensors**: per-device time-series charts with range and bucket selectors (defaults to Last 1 hour / 1 minute on load). Devices with multiple metrics render one chart per metric.
- **Battery & Status**: latest battery levels with color coding and status warnings. Zigbee uses battery % (`battery` or `battery_percentage`), LoRa battery voltage is converted to % with device-specific ranges, and mains devices show "main-powered" (green). Battery % uses the most recent telemetry that includes a battery field. Warnings show "battery low" (<25%) or "battery very low" (<10%).
Online/offline on the **All Devices** page uses `THRESHOLD_LAST_SEEN_MINUTES` from `stack/.env` (default 60 minutes).

Update the MQTT broker and PostgreSQL credentials in the config nodes if your services use non-default values. When running Node-RED inside Docker Compose, the hostnames should remain `mosquitto` and `postgres`.

The Compose file bind-mounts `stack/nodered/data` to `/data` in the container, so edits in the repo are reflected in Node-RED after a restart, and UI deploys write back to the same file. The directory mount avoids `EBUSY` errors during Node-RED's atomic save (it writes `flows.json.$$$` and renames it). If you change `flows.json`, run `docker compose -f stack/docker-compose.yml up -d nodered` then `docker compose -f stack/docker-compose.yml restart nodered` (or restart the container) to load the new flow, or use `bash scripts/45_reload_nodered.sh` to restart and verify the flow checksum. If Node-RED cannot write the file, ensure the host directory is writable by the container user.

## Important nuance (Mosquitto ACL)
Mosquitto does **not** expand environment variables inside `acl`.
This scaffold uses fixed users: `admin`, `ingest`, `control`.
Match those in your `.env` credentials.

## Basics Station TLS
The gateway LNS URI host must match `LNS_HOST` (DNS or IP) because it must match the certificate SAN.
Gateway LNS URI: `wss://<LNS_HOST>:<LNS_PORT>`

## Zigbee adapter simulator
`zigbee-adapter-sim` is a lightweight TCP listener that simulates a Zigbee serial adapter so Zigbee2MQTT can start without real hardware. The Zigbee2MQTT config points its `serial.port` to `tcp://zigbee-adapter-sim:6638`. Replace this with your actual adapter (USB or LAN) and remove the simulator service when you have real hardware.

To disable Zigbee2MQTT (no hardware yet), leave `COMPOSE_PROFILES` empty in `.env`. To enable it (with the simulator), set `COMPOSE_PROFILES=zigbee` and run `docker compose up -d`.

If you use an external MQTT simulator, you can keep Zigbee2MQTT disabled and still validate downstream flows by publishing synthetic messages to the same topics that Zigbee2MQTT and ChirpStack would normally emit.

## Health checklist
1) `docker compose ps` shows all services `Up` and `healthy` (where healthchecks are defined).
2) ChirpStack waits for PostgreSQL and Redis before starting. If `docker compose logs chirpstack` shows `Connection refused`, verify `postgres` and `redis` are running and healthy.
3) `docker compose logs chirpstack` should not show `operator class "gin_trgm_ops" does not exist for access method "gin"`.
4) `docker compose logs zigbee2mqtt` should show a successful connection to the adapter and no repeated reconnect loops.
5) Immediately after a fresh bootstrap, PostgreSQL may log `FATAL: database "chirpstack" does not exist` and `FATAL: database "poc_nodered" does not exist` before `init_postgres_users.sh` creates them. These messages should disappear once the script completes.

## Data persistence
- PostgreSQL data persists across container restarts because it uses the `pg-data` named volume. It is only lost if the volume is removed (for example, `docker compose down -v`).
- Mosquitto persists its data and logs to the `mosquitto-data` and `mosquitto-log` volumes. Retained messages and session state are preserved, but transient MQTT messages are not stored once delivered.
