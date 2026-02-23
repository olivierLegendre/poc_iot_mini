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

-- ============================================================================
-- Step 1 additive schema for device references and normalized metrics
-- ============================================================================

CREATE TABLE IF NOT EXISTS poc.device_reference (
  id BIGSERIAL PRIMARY KEY,
  network TEXT NOT NULL CHECK (network IN ('zigbee','lorawan')),
  reference_key TEXT NOT NULL,
  vendor TEXT,
  model TEXT NOT NULL,
  active_mapping_version INTEGER NOT NULL DEFAULT 1 CHECK (active_mapping_version > 0),
  mapping_file_path TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (network, reference_key)
);

CREATE TABLE IF NOT EXISTS poc.device_reference_capability (
  id BIGSERIAL PRIMARY KEY,
  device_reference_id BIGINT NOT NULL REFERENCES poc.device_reference(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability IN ('actuator','periodic_sensor','event_driven_sensor')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (device_reference_id, capability)
);

CREATE TABLE IF NOT EXISTS poc.device_reference_mapping (
  id BIGSERIAL PRIMARY KEY,
  device_reference_id BIGINT NOT NULL REFERENCES poc.device_reference(id) ON DELETE CASCADE,
  mapping_version INTEGER NOT NULL DEFAULT 1 CHECK (mapping_version > 0),
  normalized_field TEXT NOT NULL,
  source_path TEXT NOT NULL,
  data_type TEXT NOT NULL DEFAULT 'text' CHECK (data_type IN ('number','integer','boolean','text','json','timestamp')),
  unit TEXT,
  role TEXT NOT NULL DEFAULT 'metric' CHECK (role IN ('metric','status','battery','event','actuation','metadata')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  transform_hint TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (device_reference_id, mapping_version, normalized_field)
);

CREATE TABLE IF NOT EXISTS poc.device_mapping_candidate (
  id BIGSERIAL PRIMARY KEY,
  device_id BIGINT NOT NULL REFERENCES poc.devices(id) ON DELETE CASCADE,
  device_reference_id BIGINT REFERENCES poc.device_reference(id) ON DELETE SET NULL,
  source_topic TEXT NOT NULL,
  source_path TEXT NOT NULL,
  sample_value JSONB,
  inferred_data_type TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_count BIGINT NOT NULL DEFAULT 1 CHECK (seen_count > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','ignored')),
  notes TEXT,
  UNIQUE (device_id, source_path)
);

CREATE TABLE IF NOT EXISTS poc.metrics (
  id BIGSERIAL PRIMARY KEY,
  telemetry_id BIGINT REFERENCES poc.telemetry(id) ON DELETE CASCADE,
  device_id BIGINT NOT NULL REFERENCES poc.devices(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL,
  metric_name TEXT NOT NULL,
  value_number DOUBLE PRECISION,
  value_text TEXT,
  value_boolean BOOLEAN,
  value_json JSONB,
  value_type TEXT NOT NULL CHECK (value_type IN ('number','text','boolean','json')),
  unit TEXT,
  source_path TEXT,
  mapping_id BIGINT REFERENCES poc.device_reference_mapping(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE poc.devices
  ADD COLUMN IF NOT EXISTS device_reference_id BIGINT REFERENCES poc.device_reference(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS devices_reference_idx ON poc.devices(device_reference_id);
CREATE INDEX IF NOT EXISTS device_mapping_candidate_device_idx ON poc.device_mapping_candidate(device_id);
CREATE INDEX IF NOT EXISTS device_reference_mapping_ref_ver_idx ON poc.device_reference_mapping(device_reference_id, mapping_version);
CREATE INDEX IF NOT EXISTS metrics_device_metric_ts_idx ON poc.metrics(device_id, metric_name, ts DESC);
CREATE INDEX IF NOT EXISTS metrics_telemetry_idx ON poc.metrics(telemetry_id);
CREATE INDEX IF NOT EXISTS metrics_ts_idx ON poc.metrics(ts DESC);

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
