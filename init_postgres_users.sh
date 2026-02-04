#!/bin/bash
# Initialize PostgreSQL users and databases for the PoC
# This script handles database creation (which cannot be done in SQL init files)

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
cd "$ROOT/stack"

echo "Creating PostgreSQL databases..."

# Check if chirpstack database exists, create only if missing
CHIRPSTACK_EXISTS=$(docker exec postgres psql -U postgres -tc "SELECT 1 FROM pg_database WHERE datname = 'chirpstack'")
if [ -z "$CHIRPSTACK_EXISTS" ]; then
  echo "  Creating database: chirpstack"
  docker exec postgres psql -U postgres -c "CREATE DATABASE chirpstack OWNER chirpstack;"
else
  echo "  Database chirpstack already exists"
fi

# Check if poc_nodered database exists, create only if missing
NODERED_EXISTS=$(docker exec postgres psql -U postgres -tc "SELECT 1 FROM pg_database WHERE datname = 'poc_nodered'")
if [ -z "$NODERED_EXISTS" ]; then
  echo "  Creating database: poc_nodered"
  docker exec postgres psql -U postgres -c "CREATE DATABASE poc_nodered OWNER nodered;"
else
  echo "  Database poc_nodered already exists"
fi

echo ""
echo "Granting privileges..."
docker exec postgres psql -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE chirpstack TO chirpstack;"
docker exec postgres psql -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE poc_nodered TO nodered;"

echo ""
echo "Ensuring ChirpStack extensions..."
docker exec postgres psql -U postgres -d chirpstack -f /docker-entrypoint-initdb.d/02_chirpstack_extensions.sql

echo ""
echo "Setup complete! Verifying..."

echo ""
echo "PostgreSQL Roles:"
docker exec postgres psql -U postgres -t -c "SELECT rolname FROM pg_roles WHERE rolname IN ('chirpstack', 'nodered') ORDER BY rolname;"

echo ""
echo "PostgreSQL Databases:"
docker exec postgres psql -U postgres -t -c "SELECT datname FROM pg_database WHERE datname IN ('chirpstack', 'poc_nodered') ORDER BY datname;"

echo ""
echo "Testing nodered connection..."
docker exec postgres psql -U nodered -d poc_nodered -c "SELECT 'Connected as: ' || current_user || ' at ' || now() AS status;" 2>&1
