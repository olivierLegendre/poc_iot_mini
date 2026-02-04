#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT/stack"

if [ ! -f .env ]; then
  echo "ERROR: $ROOT/stack/.env not found. Copy .env.example to .env and set values."
  exit 1
fi

set -a
source ./.env
set +a

envsubst < templates/chirpstack.toml.tmpl > chirpstack/chirpstack.toml
envsubst < templates/chirpstack-gateway-bridge.toml.tmpl > gateway-bridge/chirpstack-gateway-bridge.toml
envsubst < templates/zigbee2mqtt_configuration.yaml.tmpl > zigbee2mqtt/configuration.yaml

echo "Rendered configs OK."
