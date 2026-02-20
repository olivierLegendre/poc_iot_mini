-- ============================================================================
-- PostgreSQL roles, databases, and database-level grants
-- ============================================================================
-- Executed by scripts/42_init_postgres.sh with variables from stack/.env.
-- This file is idempotent and can be applied repeatedly.
--
-- Required psql variables:
--   CHIRPSTACK_PG_USER, CHIRPSTACK_PG_PASSWORD, CHIRPSTACK_PG_DB
--   NODERED_PG_USER,   NODERED_PG_PASSWORD,   NODERED_PG_DB
-- ============================================================================

\set ON_ERROR_STOP on

-- chirpstack role
SELECT format('CREATE ROLE %I WITH LOGIN', :'CHIRPSTACK_PG_USER')
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = :'CHIRPSTACK_PG_USER'
);
\gexec

SELECT format(
  'ALTER ROLE %I WITH LOGIN PASSWORD %L',
  :'CHIRPSTACK_PG_USER',
  :'CHIRPSTACK_PG_PASSWORD'
);
\gexec

-- nodered role
SELECT format('CREATE ROLE %I WITH LOGIN', :'NODERED_PG_USER')
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = :'NODERED_PG_USER'
);
\gexec

SELECT format(
  'ALTER ROLE %I WITH LOGIN PASSWORD %L',
  :'NODERED_PG_USER',
  :'NODERED_PG_PASSWORD'
);
\gexec

-- chirpstack database
SELECT format('CREATE DATABASE %I OWNER %I', :'CHIRPSTACK_PG_DB', :'CHIRPSTACK_PG_USER')
WHERE NOT EXISTS (
  SELECT 1 FROM pg_database WHERE datname = :'CHIRPSTACK_PG_DB'
);
\gexec

SELECT format('ALTER DATABASE %I OWNER TO %I', :'CHIRPSTACK_PG_DB', :'CHIRPSTACK_PG_USER');
\gexec

SELECT format('GRANT ALL PRIVILEGES ON DATABASE %I TO %I', :'CHIRPSTACK_PG_DB', :'CHIRPSTACK_PG_USER');
\gexec

-- Node-RED database
SELECT format('CREATE DATABASE %I OWNER %I', :'NODERED_PG_DB', :'NODERED_PG_USER')
WHERE NOT EXISTS (
  SELECT 1 FROM pg_database WHERE datname = :'NODERED_PG_DB'
);
\gexec

SELECT format('ALTER DATABASE %I OWNER TO %I', :'NODERED_PG_DB', :'NODERED_PG_USER');
\gexec

SELECT format('GRANT ALL PRIVILEGES ON DATABASE %I TO %I', :'NODERED_PG_DB', :'NODERED_PG_USER');
\gexec
