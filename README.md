# Required PoC files (Ubuntu) — generated scaffold

This scaffold provides the **missing stack files** referenced by the runbook:
- `docker-compose.yml`
- Mosquitto config + ACL + passwordfile generation
- PostgreSQL init (poc.* schema)
- ChirpStack + Gateway Bridge config templates rendered from .env
- Zigbee2MQTT configuration template rendered from .env
- Node-RED Dockerfile + placeholder flows.json
- Helper scripts

## Install into your project root
Copy the contents of this zip to: `~/Public/poc`

Then:
1) `bash scripts/00_install_prereqs.sh`
2) `cp stack/.env.example stack/.env` and edit values
3) `bash scripts/15_render_configs.sh`
4) `bash scripts/20_generate_mqtt_auth.sh`
5) `bash scripts/30_generate_tls_basics_station.sh`
6) `bash scripts/40_up.sh`

## Important nuance (Mosquitto ACL)
Mosquitto does **not** expand environment variables inside `acl`.
This scaffold uses fixed users: `admin`, `ingest`, `control`.
Match those in your `.env` credentials.

## Basics Station TLS
The gateway LNS URI host must match `LNS_HOST` (DNS or IP) because it must match the certificate SAN.
Gateway LNS URI: `wss://<LNS_HOST>:<LNS_PORT>`
