-- ============================================================================
-- ChirpStack required PostgreSQL extensions
-- ============================================================================
-- Run against the ChirpStack database.
-- Executed by scripts/42_init_postgres.sh with CHIRPSTACK_PG_USER from stack/.env.
-- ============================================================================

\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS chirpstack;

SELECT format('ALTER SCHEMA chirpstack OWNER TO %I', :'CHIRPSTACK_PG_USER');
\gexec

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'ALTER EXTENSION pg_trgm SET SCHEMA chirpstack';
  ELSE
    EXECUTE 'CREATE EXTENSION pg_trgm WITH SCHEMA chirpstack';
  END IF;
END
$$;

SELECT format('GRANT USAGE, CREATE ON SCHEMA chirpstack TO %I', :'CHIRPSTACK_PG_USER');
\gexec

SELECT format('ALTER ROLE %I SET search_path = chirpstack, public', :'CHIRPSTACK_PG_USER');
\gexec
