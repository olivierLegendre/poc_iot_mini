-- Executed by scripts/42_init_postgres.sh with NODERED_PG_USER from stack/.env.
\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS poc;

CREATE TABLE IF NOT EXISTS poc.devices (
  id BIGSERIAL PRIMARY KEY,
  network TEXT NOT NULL CHECK (network IN ('zigbee','lorawan')),
  external_id TEXT NOT NULL,
  display_name TEXT,
  meta JSONB DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ DEFAULT now(),
  last_seen_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS devices_unique ON poc.devices(network, external_id);

CREATE OR REPLACE FUNCTION poc.devices_external_id_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.external_id IS DISTINCT FROM OLD.external_id THEN
    RAISE EXCEPTION 'external_id is immutable (old=%, new=%)', OLD.external_id, NEW.external_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_devices_external_id_immutable ON poc.devices;
CREATE TRIGGER trg_devices_external_id_immutable
BEFORE UPDATE OF external_id ON poc.devices
FOR EACH ROW
EXECUTE FUNCTION poc.devices_external_id_immutable();

CREATE TABLE IF NOT EXISTS poc.telemetry (
  id BIGSERIAL PRIMARY KEY,
  device_id BIGINT REFERENCES poc.devices(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_topic TEXT
);

CREATE INDEX IF NOT EXISTS telemetry_device_ts ON poc.telemetry(device_id, ts DESC);

CREATE TABLE IF NOT EXISTS poc.commands (
  id BIGSERIAL PRIMARY KEY,
  network TEXT NOT NULL CHECK (network IN ('zigbee','lorawan')),
  device_id BIGINT REFERENCES poc.devices(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  command JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','transmitted','confirmed','observed','failed')),
  status_detail TEXT
);

CREATE INDEX IF NOT EXISTS commands_created_at ON poc.commands(created_at DESC);

CREATE OR REPLACE VIEW poc.latest_telemetry AS
SELECT DISTINCT ON (d.id)
  d.id AS device_id,
  d.network,
  d.external_id,
  d.display_name,
  t.ts,
  t.metrics,
  t.raw
FROM poc.devices d
LEFT JOIN poc.telemetry t ON t.device_id = d.id
ORDER BY d.id, t.ts DESC;

SELECT format('GRANT USAGE ON SCHEMA poc TO %I', :'NODERED_PG_USER');
\gexec

SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA poc TO %I', :'NODERED_PG_USER');
\gexec

SELECT format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA poc TO %I', :'NODERED_PG_USER');
\gexec

SELECT format('GRANT EXECUTE ON FUNCTION poc.devices_external_id_immutable() TO %I', :'NODERED_PG_USER');
\gexec

SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA poc GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', :'NODERED_PG_USER');
\gexec

SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA poc GRANT USAGE, SELECT ON SEQUENCES TO %I', :'NODERED_PG_USER');
\gexec
