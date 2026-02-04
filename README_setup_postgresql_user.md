# Option A — PostgreSQL Users and Databases (Automatic Setup)

This approach automatically creates all required PostgreSQL users and databases when the stack starts:

- **Admin** (superuser): `postgres` (Docker default)
- **ChirpStack**: role with full access to `chirpstack` database
- **Node-RED**: role with full access to `poc_nodered` database

## How it works

The setup is fully automated via two components:

### 1. SQL Init File (runs on first postgres container start)

The file [stack/postgres/init/00_create_users.sql](stack/postgres/init/00_create_users.sql) runs automatically when the postgres container starts for the first time. It:

- Creates the `chirpstack` role with login and password (idempotent via PL/pgSQL exception handling)
- Creates the `nodered` role with login and password (idempotent via PL/pgSQL exception handling)
- All role creation is idempotent (safe to run multiple times)

### 2. Shell Init Script (runs when starting the full stack)

The script [init_postgres_users.sh](init_postgres_users.sh) is automatically called by `bash scripts/40_up.sh` after the stack starts. It:

- Checks if `chirpstack` database exists, creates only if missing
- Checks if `poc_nodered` database exists, creates only if missing
- Grants full privileges to each role on its respective database
- All operations are idempotent (safe to run multiple times)
- Provides clear logging of what it's doing ("Creating" vs "already exists")

## Configure ChirpStack

ChirpStack should be configured in `stack/chirpstack/chirpstack.toml` (or via template) with:

```toml
[postgresql]
dsn = "postgres://chirpstack:your_password@postgres:5432/chirpstack?sslmode=disable"
```

## Configure Node-RED (node-red-contrib-postgresql)

In Node-RED:

- Double-click any `postgresql` node
- Click the pencil icon on the `postgreSQLConfig` config
- Set:

| Field | Value |
|------|-------|
| Host | `postgres` |
| Port | `5432` |
| Database | `poc_nodered` (or your `NR_PG_DB`) |
| User | `nodered` (or your `NR_PG_USER`) |
| Password | the value you set |
| SSL | `false` (for local PoC) |

Important: If Node-RED runs in Docker **in the same compose network**, use `postgres` as host (not `localhost`).

## Verify

List all users:

```bash
docker compose exec postgres psql -U postgres -d postgres -c "\du"
```

List all databases:

```bash
docker compose exec postgres psql -U postgres -d postgres -c "\l"
```

Connect as chirpstack and verify:

```bash
docker compose exec postgres psql -U chirpstack -d chirpstack -c "SELECT now();"
```

Connect as nodered and verify:

```bash
docker compose exec postgres psql -U nodered -d poc_nodered -c "SELECT now();"
```

List tables in Node-RED database:

```bash
docker compose exec postgres psql -U nodered -d poc_nodered -c '\dt'
```

## Startup workflow

When you run `bash scripts/40_up.sh`:

1. Docker Compose starts all services including postgres
2. On first postgres startup, the SQL init file automatically creates roles
3. After a short wait, the script automatically calls `init_postgres_users.sh`
4. Database creation and privilege assignment complete
5. All services are ready to connect to PostgreSQL

## Reset (clean slate)

If you need to reset everything and start over:

```bash
bash scripts/41_down.sh
docker volume rm poc-iot_pg-data
bash scripts/40_up.sh
```

The SQL init file will re-create all roles automatically, and the shell script will create all databases.
