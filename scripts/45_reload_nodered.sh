#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
COMPOSE_FILE="$ROOT/stack/docker-compose.yml"
FLOW_HOST="$ROOT/stack/nodered/data/flows.json"

echo "Reloading Node-RED (restart to force flow reload)..."
docker compose -f "$COMPOSE_FILE" up -d nodered
docker compose -f "$COMPOSE_FILE" restart nodered

if [[ ! -f "$FLOW_HOST" ]]; then
  echo "Host flows.json not found at: $FLOW_HOST"
  exit 1
fi

HOST_SUM="$(md5sum "$FLOW_HOST" | awk '{print $1}')"
CONTAINER_SUM="$(docker exec nodered md5sum /data/flows.json | awk '{print $1}')"

echo "Host flows.json: $HOST_SUM"
echo "Container /data/flows.json: $CONTAINER_SUM"

if [[ "$HOST_SUM" != "$CONTAINER_SUM" ]]; then
  echo "WARNING: Checksums differ. Node-RED may not have loaded the latest flow yet."
  exit 1
fi
