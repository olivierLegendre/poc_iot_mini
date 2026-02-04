#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
STACK_DIR="$ROOT/stack"

if [ ! -d "$STACK_DIR" ]; then
  echo "ERROR: stack directory not found at $STACK_DIR"
  exit 1
fi

if [ ! -f "$STACK_DIR/.env" ]; then
  if [ -f "$STACK_DIR/.env.example" ]; then
    cp "$STACK_DIR/.env.example" "$STACK_DIR/.env"
    echo "Created $STACK_DIR/.env from .env.example."
    echo "Please review and update credentials, then re-run this script."
    exit 1
  fi
  echo "ERROR: $STACK_DIR/.env and .env.example are missing."
  exit 1
fi

echo "Using project root: $ROOT"

bash "$ROOT/scripts/00_install_prereqs.sh"
bash "$ROOT/scripts/10_bootstrap_workspace.sh" "$ROOT"
bash "$ROOT/scripts/15_render_configs.sh" "$ROOT"
bash "$ROOT/scripts/20_generate_mqtt_auth.sh" "$ROOT"
bash "$ROOT/scripts/30_generate_tls_basics_station.sh" "$ROOT"
bash "$ROOT/scripts/35_verify_no_secrets_tracked.sh" "$ROOT"
bash "$ROOT/scripts/40_up.sh" "$ROOT"
