#!/usr/bin/env bash
set -euo pipefail

# PostgreSQL initialization entrypoint for this project.
# Responsibilities:
# - Reconcile roles/passwords/databases from stack/.env
# - Apply ChirpStack extensions
# - Apply PoC schema for Node-RED
# Safe to re-run (idempotent SQL + grants).

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
STACK_DIR="$ROOT/stack"
POSTGRES_INIT_DIR="$STACK_DIR/postgres/init"

cd "$STACK_DIR"

if [ ! -f "$STACK_DIR/.env" ]; then
  echo "ERROR: $STACK_DIR/.env not found."
  exit 1
fi

set -a
# shellcheck disable=SC1091
source "$STACK_DIR/.env"
set +a

POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-postgres}"
POSTGRES_ADMIN_USER="${POSTGRES_ADMIN_USER:-postgres}"
POSTGRES_ADMIN_DB="${POSTGRES_ADMIN_DB:-postgres}"

CHIRPSTACK_PG_USER="${CHIRPSTACK_PG_USER:-chirpstack}"
CHIRPSTACK_PG_DB="${CHIRPSTACK_PG_DB:-chirpstack}"
CHIRPSTACK_PG_PASSWORD="${CHIRPSTACK_PG_PASSWORD:-}"

NODERED_PG_USER="${NODERED_PG_USER:-nodered}"
NODERED_PG_DB="${NODERED_PG_DB:-poc_nodered}"
NODERED_PG_PASSWORD="${NODERED_PG_PASSWORD:-}"

for var_name in CHIRPSTACK_PG_PASSWORD NODERED_PG_PASSWORD; do
  if [ -z "${!var_name:-}" ]; then
    echo "ERROR: $var_name is empty in stack/.env."
    exit 1
  fi
done

psql_apply_file() {
  local db_name="$1"
  local sql_file="$2"

  if [ ! -f "$sql_file" ]; then
    echo "ERROR: SQL file not found: $sql_file"
    exit 1
  fi

  docker exec -i "$POSTGRES_CONTAINER" psql \
    -v ON_ERROR_STOP=1 \
    -U "$POSTGRES_ADMIN_USER" \
    -d "$db_name" \
    -v CHIRPSTACK_PG_USER="$CHIRPSTACK_PG_USER" \
    -v CHIRPSTACK_PG_DB="$CHIRPSTACK_PG_DB" \
    -v CHIRPSTACK_PG_PASSWORD="$CHIRPSTACK_PG_PASSWORD" \
    -v NODERED_PG_USER="$NODERED_PG_USER" \
    -v NODERED_PG_DB="$NODERED_PG_DB" \
    -v NODERED_PG_PASSWORD="$NODERED_PG_PASSWORD" \
    < "$sql_file"
}

echo "Waiting for PostgreSQL container '$POSTGRES_CONTAINER' to become ready..."
until docker exec "$POSTGRES_CONTAINER" pg_isready -U "$POSTGRES_ADMIN_USER" -d "$POSTGRES_ADMIN_DB" >/dev/null 2>&1; do
  sleep 1
done
echo "PostgreSQL is ready."

echo ""
echo "Applying role/database/grant init SQL..."
psql_apply_file "$POSTGRES_ADMIN_DB" "$POSTGRES_INIT_DIR/00_create_users.sql"

echo ""
echo "Applying ChirpStack extension SQL..."
psql_apply_file "$CHIRPSTACK_PG_DB" "$POSTGRES_INIT_DIR/02_chirpstack_extensions.sql"

echo ""
echo "Applying PoC schema SQL..."
psql_apply_file "$NODERED_PG_DB" "$POSTGRES_INIT_DIR/01_poc_schema.sql"

echo ""
echo "Verification:"
docker exec "$POSTGRES_CONTAINER" psql -U "$POSTGRES_ADMIN_USER" -d "$POSTGRES_ADMIN_DB" -t -c \
  "SELECT datname FROM pg_database WHERE datname IN ('${CHIRPSTACK_PG_DB}', '${NODERED_PG_DB}') ORDER BY datname;"
docker exec "$POSTGRES_CONTAINER" psql -U "$NODERED_PG_USER" -d "$NODERED_PG_DB" -c \
  "SELECT 'Connected as: ' || current_user || ' at ' || now() AS status;"
