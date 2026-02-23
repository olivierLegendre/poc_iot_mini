'use strict';

function buildDeviceUpsertQuery(msg) {
  const p = msg.poc;
  const displayName = p.displayName || p.deviceId;

  msg.query = `
  INSERT INTO poc.devices (network, external_id, display_name, meta, first_seen_at, last_seen_at)
  VALUES ($1, $2, $3, $4::jsonb, now(), $5)
  ON CONFLICT (network, external_id)
  DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at,
                display_name = EXCLUDED.display_name,
                meta = poc.devices.meta || EXCLUDED.meta;
`;

  const meta = {
    last_topic: p.topic,
    last_event_type: p.eventType,
    last_keys: Object.keys(p.metrics || {})
  };

  msg.params = [p.source, p.deviceId, displayName, JSON.stringify(meta), p.ts];
  return msg;
}

function buildTelemetryInsertRawQuery(msg) {
  const p = msg.poc;

  msg.query = `
  WITH inserted AS (
    INSERT INTO poc.telemetry (device_id, ts, metrics, raw, source_topic)
    SELECT id, $1, $2::jsonb, $3::jsonb, $4
    FROM poc.devices
    WHERE network = $5 AND external_id = $6
    RETURNING id AS telemetry_id, device_id, ts, metrics
  )
  SELECT telemetry_id, device_id, ts, metrics
  FROM inserted;
`;

  msg.params = [
    p.ts,
    JSON.stringify(p.metrics || {}),
    JSON.stringify(p.raw || {}),
    p.topic,
    p.source,
    p.deviceId
  ];

  return msg;
}

function buildDeviceMappingCandidateUpsertQuery(msg) {
  const p = msg.poc || {};
  const candidates = Array.isArray(msg.mappingCandidates) ? msg.mappingCandidates : [];

  if (!p.source || !p.deviceId || candidates.length === 0) {
    return null;
  }

  msg.query = `
WITH dev AS (
  SELECT id
  FROM poc.devices
  WHERE network = $1 AND external_id = $2
  LIMIT 1
), rows AS (
  SELECT *
  FROM jsonb_to_recordset($4::jsonb)
  AS r(source_path text, sample_value jsonb, inferred_data_type text)
)
INSERT INTO poc.device_mapping_candidate (
  device_id,
  source_topic,
  source_path,
  sample_value,
  inferred_data_type,
  first_seen_at,
  last_seen_at,
  seen_count,
  status
)
SELECT
  dev.id,
  $3,
  rows.source_path,
  rows.sample_value,
  rows.inferred_data_type,
  now(),
  now(),
  1,
  'pending'
FROM dev
JOIN rows ON TRUE
ON CONFLICT (device_id, source_path)
DO UPDATE SET
  last_seen_at = now(),
  seen_count = poc.device_mapping_candidate.seen_count + 1,
  sample_value = EXCLUDED.sample_value,
  inferred_data_type = COALESCE(EXCLUDED.inferred_data_type, poc.device_mapping_candidate.inferred_data_type),
  source_topic = EXCLUDED.source_topic;
`;

  msg.params = [
    p.source,
    p.deviceId,
    p.topic || '',
    JSON.stringify(candidates)
  ];

  return msg;
}

function buildMetricsMappingLookupQuery(msg) {
  const rows = Array.isArray(msg.payload) ? msg.payload : [];
  const telemetry = rows[0];

  if (!telemetry || !telemetry.device_id || !telemetry.telemetry_id) {
    return null;
  }

  msg.telemetryInserted = telemetry;
  msg.query = `
SELECT
  drm.id AS mapping_id,
  drm.normalized_field,
  drm.source_path,
  drm.data_type,
  drm.unit
FROM poc.devices d
JOIN poc.device_reference dr
  ON dr.id = d.device_reference_id
JOIN poc.device_reference_mapping drm
  ON drm.device_reference_id = dr.id
 AND drm.mapping_version = dr.active_mapping_version
WHERE d.id = $1
  AND drm.is_active = true
ORDER BY drm.id;
`;
  msg.params = [telemetry.device_id];
  return msg;
}

function buildMetricsInsertQuery(msg) {
  const telemetry = msg.telemetryInserted || {};
  const rows = Array.isArray(msg.metricRows) ? msg.metricRows : [];

  if (!telemetry.telemetry_id || !telemetry.device_id || !telemetry.ts || rows.length === 0) {
    return null;
  }

  msg.query = `
INSERT INTO poc.metrics (
  telemetry_id,
  device_id,
  ts,
  metric_name,
  value_number,
  value_text,
  value_boolean,
  value_json,
  value_type,
  unit,
  source_path,
  mapping_id
)
SELECT
  $1,
  $2,
  $3,
  r.metric_name,
  r.value_number,
  r.value_text,
  r.value_boolean,
  r.value_json,
  r.value_type,
  r.unit,
  r.source_path,
  r.mapping_id
FROM jsonb_to_recordset($4::jsonb) AS r(
  metric_name text,
  value_number double precision,
  value_text text,
  value_boolean boolean,
  value_json jsonb,
  value_type text,
  unit text,
  source_path text,
  mapping_id bigint
);
`;

  msg.params = [
    telemetry.telemetry_id,
    telemetry.device_id,
    telemetry.ts,
    JSON.stringify(rows)
  ];
  return msg;
}

function buildActivityCompleteQuery(msg, flow) {
  const rangeMap = {
    '1h': '1 hour',
    '24h': '24 hours',
    '7d': '7 days'
  };

  const source = flow.get('activity_source') || 'both';
  const range = flow.get('activity_range') || '1h';
  const interval = rangeMap[range] || '1 hour';

  const params = [];
  let where = `t.ts >= now() - interval '${interval}'`;

  if (source !== 'both') {
    params.push(source);
    where += ` AND d.network = $${params.length}`;
  }

  msg.query = `SELECT date_trunc('minute', t.ts) AS bucket,
       count(*) AS events
FROM poc.telemetry t
JOIN poc.devices d ON d.id = t.device_id
WHERE ${where}
GROUP BY bucket
ORDER BY bucket;`;
  msg.params = params;
  return msg;
}

function buildAllDevicesQuery(msg) {
  msg.query = `SELECT d.network,d.external_id,d.display_name,d.last_seen_at, t.ts AS last_ts, t.metrics
FROM poc.devices d
LEFT JOIN poc.latest_telemetry t ON t.device_id = d.id
ORDER BY d.network, d.external_id;`;
  msg.params = [];
  return msg;
}

function buildActuatorStatusQuery(msg) {
  msg.query = `SELECT d.network,d.external_id,d.display_name, t.ts, t.metrics
FROM poc.devices d
LEFT JOIN poc.latest_telemetry t ON t.device_id = d.id
WHERE d.external_id IN ('0xa4c1389274f470fa','a1a2a3a4a5a6a7a8')
ORDER BY d.external_id;`;
  msg.params = [];
  return msg;
}

function buildToggleLookupQuery(msg) {
  const id = msg.payload;
  msg.targetDevice = id;
  msg.query = `SELECT d.network,d.external_id,d.display_name,d.meta,t.metrics
FROM poc.devices d
LEFT JOIN poc.latest_telemetry t ON t.device_id=d.id
WHERE d.external_id=$1
LIMIT 1;`;
  msg.params = [id];
  return msg;
}

function buildEventSensorChangesQuery(msg) {
  msg.query = `WITH latest AS (
  SELECT d.external_id, d.display_name, t.ts AS last_ts
  FROM poc.devices d
  LEFT JOIN poc.latest_telemetry t ON t.device_id = d.id
  WHERE d.external_id IN ('0xf044d3fffe9171eb','1122334455667788')
), relevant AS (
  SELECT d.external_id, t.ts,
         CASE
           WHEN d.external_id='0xf044d3fffe9171eb' THEN 'occupancy'
           WHEN d.external_id='1122334455667788' THEN 'door_open'
         END AS metric_key,
         CASE
           WHEN d.external_id='0xf044d3fffe9171eb' THEN t.metrics->>'occupancy'
           WHEN d.external_id='1122334455667788' THEN COALESCE(t.metrics->>'door_open', t.metrics->'object'->>'door_open')
         END AS metric_value
  FROM poc.telemetry t
  JOIN poc.devices d ON d.id=t.device_id
  WHERE d.external_id IN ('0xf044d3fffe9171eb','1122334455667788')
  UNION ALL
  SELECT d.external_id, t.ts,
         'motion' AS metric_key,
         t.metrics->>'motion' AS metric_value
  FROM poc.telemetry t
  JOIN poc.devices d ON d.id=t.device_id
  WHERE d.external_id='0xf044d3fffe9171eb'
), diff AS (
  SELECT external_id, metric_key, ts,
         lag(metric_value) OVER (PARTITION BY external_id, metric_key ORDER BY ts) AS old_value,
         metric_value AS new_value
  FROM relevant
  WHERE metric_value IS NOT NULL
), ranked AS (
  SELECT *, row_number() OVER (PARTITION BY external_id ORDER BY ts DESC) AS rn
  FROM diff
  WHERE old_value IS NOT NULL AND old_value <> new_value
), changes AS (
  SELECT external_id, metric_key, old_value, new_value, ts
  FROM ranked
  WHERE rn <= 5
)
SELECT l.external_id, l.display_name, l.last_ts, c.metric_key, c.old_value, c.new_value, c.ts
FROM latest l
LEFT JOIN changes c ON c.external_id = l.external_id
ORDER BY l.external_id, c.ts DESC NULLS LAST;`;
  msg.params = [];
  return msg;
}

function buildPeriodicThQuery(msg, flow) {
  const rangeMap = { '1h': '1 hour' };
  const range = flow.get('periodic_range') || '1h';
  const bucket = flow.get('periodic_bucket') || '1 minute';
  const interval = rangeMap[range] || '1 hour';
  msg.query = `WITH candidate AS (
  SELECT d.id
  FROM poc.devices d
  JOIN poc.latest_telemetry lt ON lt.device_id = d.id
  WHERE d.network = 'zigbee'
    AND (
      lt.metrics ? 'temperature'
      OR lt.metrics ? 'humidity'
      OR (lt.metrics->'object') ? 'temperature_c'
      OR (lt.metrics->'object') ? 'humidity_pct'
    )
  ORDER BY COALESCE(lt.ts, d.last_seen_at) DESC NULLS LAST
  LIMIT 1
), base AS (
  SELECT date_bin(interval '${bucket}', t.ts, TIMESTAMPTZ '1970-01-01') AS bucket,
         NULLIF(COALESCE(t.metrics->>'temperature', t.metrics->'object'->>'temperature_c'), '') AS temperature,
         NULLIF(COALESCE(t.metrics->>'humidity', t.metrics->'object'->>'humidity_pct'), '') AS humidity,
         t.ts
  FROM poc.telemetry t
  JOIN candidate c ON c.id = t.device_id
  WHERE t.ts >= now() - interval '${interval}'
)
SELECT bucket, 'temperature' AS series, avg((temperature)::double precision) AS value FROM base WHERE temperature IS NOT NULL GROUP BY bucket UNION ALL SELECT bucket, 'humidity' AS series, avg((humidity)::double precision) AS value FROM base WHERE humidity IS NOT NULL GROUP BY bucket
ORDER BY bucket;`;
  msg.params = [];
  return msg;
}

function buildPeriodicLuxQuery(msg, flow) {
  const rangeMap = { '1h': '1 hour' };
  const range = flow.get('periodic_range') || '1h';
  const bucket = flow.get('periodic_bucket') || '1 minute';
  const interval = rangeMap[range] || '1 hour';
  msg.query = `WITH base AS (
  SELECT date_bin(interval '${bucket}', t.ts, TIMESTAMPTZ '1970-01-01') AS bucket,
       NULLIF(t.metrics->>'illuminance','') AS illuminance,
       t.ts
  FROM poc.telemetry t
  JOIN poc.devices d ON d.id=t.device_id
  WHERE d.external_id='0xa4c1384a6572348b'
    AND t.ts >= now() - interval '${interval}'
)
SELECT bucket, 'illuminance' AS series, avg((illuminance)::double precision) AS value FROM base WHERE illuminance IS NOT NULL GROUP BY bucket
ORDER BY bucket;`;
  msg.params = [];
  return msg;
}

function buildPeriodicDraginoQuery(msg, flow) {
  const rangeMap = { '1h': '1 hour' };
  const range = flow.get('periodic_range') || '1h';
  const bucket = flow.get('periodic_bucket') || '1 minute';
  const interval = rangeMap[range] || '1 hour';
  msg.query = `WITH base AS (
  SELECT date_bin(interval '${bucket}', t.ts, TIMESTAMPTZ '1970-01-01') AS bucket,
       NULLIF(COALESCE(t.metrics->>'temperature', t.metrics->'object'->>'temperature_c'), '') AS temperature,
       NULLIF(COALESCE(t.metrics->>'humidity', t.metrics->'object'->>'humidity_pct'), '') AS humidity,
       t.ts
  FROM poc.telemetry t
  JOIN poc.devices d ON d.id=t.device_id
  WHERE d.external_id='0102030405060708'
    AND t.ts >= now() - interval '${interval}'
)
SELECT bucket, 'temperature' AS series, avg((temperature)::double precision) AS value FROM base WHERE temperature IS NOT NULL GROUP BY bucket UNION ALL SELECT bucket, 'humidity' AS series, avg((humidity)::double precision) AS value FROM base WHERE humidity IS NOT NULL GROUP BY bucket
ORDER BY bucket;`;
  msg.params = [];
  return msg;
}

function buildBatteryStatusQuery(msg) {
  msg.query = `SELECT d.external_id,d.display_name,d.network,
       t.ts,t.metrics,
       b.ts AS battery_ts, b.metrics AS battery_metrics
FROM poc.devices d
LEFT JOIN poc.latest_telemetry t ON t.device_id=d.id
LEFT JOIN LATERAL (
  SELECT tt.ts, tt.metrics
  FROM poc.telemetry tt
  WHERE tt.device_id=d.id
    AND (
      tt.metrics ? 'battery'
      OR tt.metrics ? 'battery_percentage'
      OR tt.metrics ? 'battery_v'
      OR (tt.metrics->'object') ? 'battery_v'
    )
  ORDER BY tt.ts DESC
  LIMIT 1
) b ON TRUE
ORDER BY d.network,d.external_id;`;
  msg.params = [];
  return msg;
}

module.exports = {
  devices: {
    buildUpsertQuery: buildDeviceUpsertQuery
  },
  telemetry: {
    buildInsertRawQuery: buildTelemetryInsertRawQuery
  },
  deviceMappingCandidate: {
    buildUpsertQuery: buildDeviceMappingCandidateUpsertQuery
  },
  metrics: {
    buildMappingLookupQuery: buildMetricsMappingLookupQuery,
    buildInsertQuery: buildMetricsInsertQuery
  },
  dashboard: {
    buildActivityCompleteQuery,
    buildAllDevicesQuery,
    buildActuatorStatusQuery,
    buildToggleLookupQuery,
    buildEventSensorChangesQuery,
    buildPeriodicThQuery,
    buildPeriodicLuxQuery,
    buildPeriodicDraginoQuery,
    buildBatteryStatusQuery
  }
};
