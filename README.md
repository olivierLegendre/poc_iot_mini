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
7) `bash scripts/40_docker_up.sh`

Note: `scripts/42_init_postgres.sh` is the PostgreSQL initialization entrypoint. It reconciles roles/databases/passwords from `stack/.env`, applies ChirpStack extensions, and applies the PoC schema SQL.

## Additive Schema Foundation
The PostgreSQL schema now includes additive tables for scalable device typing and mapping:

- `poc.device_reference`
- `poc.device_reference_capability`
- `poc.device_reference_mapping`
- `poc.device_mapping_candidate`
- `poc.metrics`

Current Node-RED behavior is unchanged: ingestion still writes to `poc.devices` and `poc.telemetry` (including raw payloads). The new tables are forward-compatible schema groundwork for a mapping/repository layer.

## One-shot setup
You can run a single setup script from anywhere inside the repository:
`bash scripts/setup_all.sh`

If `.env` does not exist, the script will copy `.env.example` to `.env` and stop so you can review credentials before re-running it.

## Node-RED + FlowFuse Dashboard base flow
The Node-RED `stack/nodered/data/flows.json` file includes a base ingestion flow that:
- Subscribes to `zigbee2mqtt/#` and `application/+/device/+/event/#`.
- Normalizes messages into a single envelope.
- Upserts `poc.devices` and inserts `poc.telemetry` rows.
- Uses `domain.*` / `repo.*` naming for ingest-layer separation (business logic vs data access).
- Extracts all payload fields with dotted paths and upserts candidates into `poc.device_mapping_candidate`.
- Optionally materializes mapped values into `poc.metrics` when:
  - the device has `device_reference_id`,
  - active mappings exist in `poc.device_reference_mapping`,
  - and mapped source paths are present in the telemetry payload.
- Uses `repo.dashboard.*` query builders and `domain.dashboard.*` formatters for dashboard read paths (instead of embedding SQL/format logic directly in function nodes).
- Keeps `flows.json` Function nodes as thin wrappers (`repo.*` / `domain.*`), with implementation logic in `stack/nodered/data/lib/`.
- Loads `domain` and `repo` implementations from external files:
  - `stack/nodered/data/lib/domain/index.js`
  - `stack/nodered/data/lib/repo/index.js`
  configured via `functionGlobalContext` in `stack/nodered/data/settings.js`.
- Does not own PostgreSQL bootstrap. Roles/databases/extensions/schema are initialized by `scripts/42_init_postgres.sh`.
- Uses immutable canonical device IDs for `poc.devices.external_id`:
  - Zigbee: `ieee_address` (EUI-64).
  - LoRaWAN: `DevEUI` (lowercase).
- Persists reference auto-link hints in `poc.devices.meta.reference_hints`:
  - Zigbee hints are enriched from `zigbee2mqtt/bridge/devices` / `zigbee2mqtt/bridge/event` and include `definition.vendor`, `definition.model`, `model_id`, and `manufacturer`.
  - LoRaWAN hints are enriched from ChirpStack `deviceInfo` and include `deviceProfileName`, `deviceProfileId`, and `devEui`.
- Exposes device-reference suggestion helpers:
  - `repo.deviceReference.buildSuggestionQuery(msg)` returns deterministic suggestion rows with blocked reasons when required key parts are missing.
  - `domain.mapping.formatReferenceSuggestions(msg)` formats suggestion rows into explicit statuses (`blocked`, `suggest_link_existing`, `suggest_create_reference`, `suggest_relink`, `already_linked`).
  - Suggestion status/reason labels are centralized in `stack/nodered/data/lib/domain/messages.js`.
- Exposes device-reference create/update helpers:
  - `domain.mapping.normalizeDeviceReferenceCreateInput(msg)` validates and normalizes create payloads into `msg.deviceReferenceInput`, with structured validation output in `msg.deviceReferenceValidation`.
  - `domain.mapping.normalizeDeviceReferenceUpdateInput(msg)` validates and normalizes update payloads into `msg.deviceReferenceInput`, with structured validation output in `msg.deviceReferenceValidation`.
  - `repo.deviceReference.buildCreateQuery(msg)` / `repo.deviceReference.buildUpdateQuery(msg)` build persistence queries from `msg.deviceReferenceInput` (including capability replacement when `capabilities` is provided).
  - `repo.deviceReference.buildListQuery(msg)` and `domain.mapping.formatDeviceReferences(msg)` support consistent list/read formatting.
- Exposes minimal Node-RED HTTP API endpoints for mapping workflows:
  - `GET /api/v1/device-references/suggestions` (query params: `network`, `only_unlinked`)
  - `GET /api/v1/device-references` (query param: `network`)
  - `POST /api/v1/device-references` (supports optional `capabilities` array)
  - `PUT /api/v1/device-references/:id` (supports optional `capabilities` array; when provided, capabilities are replaced)
  - `GET /api/v1/device-references/:id/mapping-fields`
  - `PUT /api/v1/device-references/:id/mappings` (replaces mappings for the active mapping version)
  - `POST /api/v1/device-reference-links`
  API responses are wrapped as `{ ok: true, data: ... }` on success and `{ ok: false, error: { code, message, details } }` on validation or business-rule failures.
- Builds FlowFuse Dashboard pages with:
- **PoC activity** charts (live, record, and complete views). Defaults on load: Source = "Both", Range = "Last 1 hour".
- **All Devices** (`/devices`): a list of all devices that have sent data, with online/offline based on last uplink (online if seen within 1 hour), plus a `device_reference` selector to manually assign or re-assign a device to an existing reference.
  - The current reference label avoids duplicate formatting when display name equals key.
  - The action button is styled as enabled only when assignment is possible and grayed out otherwise.
  - The button label is `Assign` for unlinked devices and `Re-assign` for already linked devices.
- **Actuators** (`/actuators`): dynamically generated from device-reference capabilities/mappings (no hardcoded device IDs). Controls and status rows are built from mapped actuators and their latest telemetry.
- **Event Sensors** (`/event-sensors`): dynamically generated from mappings with role `event`; shows the latest 5 value transitions per mapped event field/device and online/offline status.
- **Periodic Sensors** (`/periodic-sensors`): dynamically generated from references with capability `periodic_sensor` and mappings with role `metric`. Only numeric mappings (`number` / `integer`) are charted. Rendering is generic (parameter over time), with one chart per mapped metric and UI grouping by device.
- **Battery & Status** (`/battery-status`): latest battery levels with color coding and status warnings using generic telemetry-driven rules (no device-specific hardcoded IDs). Warnings show "battery low" (<25%) or "battery very low" (<10%).
- **Device References** (`/devices-references`): reference management page with mapping suggestions and reference actions:
  - list deterministic mapping suggestions per device,
  - link a device to an existing reference,
  - create a reference from a suggestion (including capability selection) and link in one action,
  - and update existing references (display name and capabilities).
- **Device Mapping** (`/device-mapping`): page for one selected `device_reference` at a time, showing available candidate fields and letting you decide:
  - which fields are used,
  - the mapping role (`metric`, `status`, `battery`, `event`, `actuation`, `metadata`),
  - normalized field name,
  - data type and unit,
  - and active state.
- Dashboard form controls (`select`, `input`, `textarea`, checkboxes/radios, and buttons) include shared interactive styling so editable fields are visually distinct from plain text, with explicit hover/focus/disabled states.
Online/offline on the **All Devices** page uses `THRESHOLD_LAST_SEEN_MINUTES` from `stack/.env` (default 60 minutes).

Update the MQTT broker and PostgreSQL credentials in the config nodes if your services use non-default values. When running Node-RED inside Docker Compose, the hostnames should remain `mosquitto` and `postgres`.

The Compose file bind-mounts `stack/nodered/data` to `/data` in the container, so edits in the repo are reflected in Node-RED after a restart, and UI deploys write back to the same file. The directory mount avoids `EBUSY` errors during Node-RED's atomic save (it writes `flows.json.$$$` and renames it). If you change `flows.json`, run `docker compose -f stack/docker-compose.yml up -d nodered` then `docker compose -f stack/docker-compose.yml restart nodered` (or restart the container) to load the new flow, or use `bash scripts/helpers/reload_nodered.sh` to restart and verify the flow checksum. If Node-RED cannot write the file, ensure the host directory is writable by the container user.

## Important nuance (Mosquitto ACL)
Mosquitto does **not** expand environment variables inside `acl`.
This scaffold uses fixed users: `admin`, `ingest`, `control`.
Match those in your `.env` credentials.

## Basics Station TLS
The gateway LNS URI host must match `LNS_HOST` (DNS or IP) because it must match the certificate SAN.
Gateway LNS URI: `wss://<LNS_HOST>:<LNS_PORT>`

## Zigbee runtime
Zigbee2MQTT configuration is rendered from `stack/.env` and `stack/templates/zigbee2mqtt_configuration.yaml.tmpl`.

Source-of-truth variables:
- Coordinator endpoint: `SLZB06_IP`, `SLZB06_PORT`
- Zigbee network: `Z2M_CHANNEL`, `Z2M_PAN_ID`, `Z2M_EXT_PAN_ID`, `Z2M_NETWORK_KEY`
- Profile activation: `COMPOSE_PROFILES=zigbee`

After any `.env` Zigbee change:
1) `bash scripts/15_render_configs.sh`
2) `docker compose -f stack/docker-compose.yml up -d zigbee2mqtt`
3) `docker compose -f stack/docker-compose.yml logs --tail 200 zigbee2mqtt`

If you use an external MQTT simulator, it can run side by side with real devices by publishing synthetic messages to the same topics that Zigbee2MQTT and ChirpStack use.

## Hardware-specific guides
- SMLIGHT SLZB-06U (Zigbee coordinator): `devices/zigbee/SMLIGHT_SLZB-06U/README.md`
- HZ light sensor (periodic Zigbee sensor): `devices/zigbee/HZ_LIGHT_ZIGBEE/README.md`
- SONOFF SNZB-03P (event-driven motion sensor): `devices/zigbee/SONOFF_SNZB_03P/README.md`
- NOUS A1Z (actuator smart plug for E3 ON/OFF): `devices/zigbee/NOUS_A1Z/README.md`
- RAK WisGate Edge Lite 2 V2 (LoRaWAN gateway for F1-F3): `devices/lora/wisgate_edge_lite_2/README.md`

## Health checklist
1) `docker compose ps` shows all services `Up` and `healthy` (where healthchecks are defined).
2) ChirpStack waits for PostgreSQL and Redis before starting. If `docker compose logs chirpstack` shows `Connection refused`, verify `postgres` and `redis` are running and healthy.
3) `docker compose logs chirpstack` should not show `operator class "gin_trgm_ops" does not exist for access method "gin"`.
4) `docker compose logs zigbee2mqtt` should show a successful connection to the adapter and no repeated reconnect loops.
5) If PostgreSQL bootstrap fails, `scripts/40_docker_up.sh` exits and tears down containers with `docker compose down` (volumes are preserved).

## Data persistence
- PostgreSQL data persists across container restarts because it uses the `pg-data` named volume. It is only lost if the volume is removed (for example, `docker compose down -v`).
- Mosquitto persists its data and logs to the `mosquitto-data` and `mosquitto-log` volumes. Retained messages and session state are preserved, but transient MQTT messages are not stored once delivered.
