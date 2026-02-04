#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT/stack"

if [ ! -f .env ]; then
  echo "ERROR: .env missing. Copy .env.example to .env and set values."
  exit 1
fi

set -a
source ./.env
set +a

PASSFILE="$ROOT/stack/mosquitto/passwordfile"

sudo rm -f "$PASSFILE"
sudo touch "$PASSFILE"
sudo chown root:root "$PASSFILE"
sudo chmod 600 "$PASSFILE"

docker run --rm -v "$PASSFILE:/pwfile" eclipse-mosquitto:2.0 \
  sh -c "mosquitto_passwd -b /pwfile '$MQTT_ADMIN_USER' '$MQTT_ADMIN_PASS' && \
         mosquitto_passwd -b /pwfile '$MQTT_INGEST_USER' '$MQTT_INGEST_PASS' && \
         mosquitto_passwd -b /pwfile '$MQTT_CONTROL_USER' '$MQTT_CONTROL_PASS'"

echo "Generated mosquitto passwordfile: $PASSFILE"
