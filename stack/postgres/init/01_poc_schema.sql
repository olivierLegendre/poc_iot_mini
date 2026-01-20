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
