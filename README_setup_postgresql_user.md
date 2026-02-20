# PostgreSQL Initialization (Single Entrypoint)

PostgreSQL initialization is managed by one orchestrator script:

- `scripts/42_init_postgres.sh`

This script is called by `scripts/40_docker_up.sh` after containers start.

## Responsibilities

`scripts/42_init_postgres.sh` is the single entrypoint for PostgreSQL init. It:

- reads credentials and DB names from `stack/.env`
- waits for PostgreSQL readiness
- applies SQL scripts from `stack/postgres/init` in a controlled order
- verifies resulting databases and connectivity

SQL ownership stays in PostgreSQL files:

- `stack/postgres/init/00_create_users.sql`: roles, databases, DB-level grants
- `stack/postgres/init/02_chirpstack_extensions.sql`: ChirpStack schema/extensions
- `stack/postgres/init/01_poc_schema.sql`: PoC schema, tables, indexes, grants

All scripts are idempotent.

## Important Behavior

- The stack no longer relies on `/docker-entrypoint-initdb.d`.
- Re-running `bash scripts/40_docker_up.sh` is safe.
- If PostgreSQL init fails, `scripts/40_docker_up.sh` fails fast and runs `docker compose down` (without deleting volumes).

## Source of Truth for Credentials

Set values in `stack/.env`:

- `POSTGRES_ADMIN_USER`
- `POSTGRES_ADMIN_DB`
- `POSTGRES_ADMIN_PASSWORD`
- `CHIRPSTACK_PG_DB`
- `CHIRPSTACK_PG_USER`
- `CHIRPSTACK_PG_PASSWORD`
- `NODERED_PG_DB`
- `NODERED_PG_USER`
- `NODERED_PG_PASSWORD`

## Startup Workflow

When you run `bash scripts/40_docker_up.sh`:

1. Docker Compose starts containers.
2. `scripts/42_init_postgres.sh` runs.
3. SQL files in `stack/postgres/init` are applied.
4. Verification queries run.
5. Script exits successfully only if initialization is complete.

## Verification

```bash
docker compose -f stack/docker-compose.yml exec postgres psql -U postgres -d postgres -c "\du"
docker compose -f stack/docker-compose.yml exec postgres psql -U postgres -d postgres -c "\l"
docker compose -f stack/docker-compose.yml exec postgres psql -U nodered -d poc_nodered -c "SELECT now();"
docker compose -f stack/docker-compose.yml exec postgres psql -U chirpstack -d chirpstack -c "SELECT now();"
docker compose -f stack/docker-compose.yml exec postgres psql -U nodered -d poc_nodered -c "\dt poc.*"
```
