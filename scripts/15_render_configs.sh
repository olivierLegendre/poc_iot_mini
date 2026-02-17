#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT/stack"

extract_root_yaml_section() {
  local file="$1"
  local section="$2"

  awk -v section="$section" '
    BEGIN { in_section=0 }
    $0 ~ ("^" section ":[[:space:]]*$") {
      in_section=1
      print
      next
    }
    in_section == 1 {
      if ($0 ~ "^[^[:space:]#][^:]*:[[:space:]]*" && $0 !~ ("^" section ":[[:space:]]*$")) {
        exit
      }
      print
    }
  ' "$file"
}

if [ ! -f .env ]; then
  echo "ERROR: $ROOT/stack/.env not found. Copy .env.example to .env and set values."
  exit 1
fi

set -a
source ./.env
set +a

envsubst < templates/chirpstack.toml.tmpl > chirpstack/chirpstack.toml
envsubst < templates/chirpstack-gateway-bridge.toml.tmpl > gateway-bridge/chirpstack-gateway-bridge.toml

Z2M_CONFIG_PATH="zigbee2mqtt/configuration.yaml"
Z2M_TMP_PATH="$(mktemp)"
envsubst < templates/zigbee2mqtt_configuration.yaml.tmpl > "$Z2M_TMP_PATH"

if [ -f "$Z2M_CONFIG_PATH" ]; then
  for section in devices groups; do
    section_content="$(extract_root_yaml_section "$Z2M_CONFIG_PATH" "$section")"
    if [ -n "$section_content" ]; then
      {
        printf "\n"
        printf "%s\n" "$section_content"
      } >> "$Z2M_TMP_PATH"
    fi
  done
fi

mv "$Z2M_TMP_PATH" "$Z2M_CONFIG_PATH"

echo "Rendered configs OK."
