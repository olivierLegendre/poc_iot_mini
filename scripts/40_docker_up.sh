#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT/stack"

cleanup_on_error() {
  local exit_code=$?
  echo ""
  echo "ERROR: Stack bootstrap failed (exit code $exit_code)."
  echo "Stopping stack with 'docker compose down' (volumes preserved)..."
  docker compose down || true
  exit "$exit_code"
}

trap cleanup_on_error ERR

echo "Starting stack containers..."
docker compose up -d --build

echo ""
echo "Initializing PostgreSQL (roles, databases, grants, extensions, schema)..."
bash "$ROOT/scripts/42_init_postgres.sh" "$ROOT"

echo ""
echo "Stack is up and PostgreSQL initialization completed."
docker ps
