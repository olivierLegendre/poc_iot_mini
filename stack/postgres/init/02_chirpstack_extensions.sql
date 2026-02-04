-- ============================================================================
-- ChirpStack required PostgreSQL extensions
-- ============================================================================
-- Run against the chirpstack database.

CREATE SCHEMA IF NOT EXISTS chirpstack;
ALTER SCHEMA chirpstack OWNER TO chirpstack;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'ALTER EXTENSION pg_trgm SET SCHEMA chirpstack';
  ELSE
    EXECUTE 'CREATE EXTENSION pg_trgm WITH SCHEMA chirpstack';
  END IF;
END
$$;

GRANT USAGE, CREATE ON SCHEMA chirpstack TO chirpstack;
ALTER ROLE chirpstack SET search_path = chirpstack, public;
