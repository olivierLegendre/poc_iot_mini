#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT/stack"
docker compose up -d --build
docker ps

# Wait for postgres to be ready
echo ""
echo "Waiting for postgres to be ready..."
sleep 5

# Create databases (roles created automatically by SQL init file)
echo ""
echo "Initializing PostgreSQL users and databases..."
bash "$ROOT/init_postgres_users.sh"
