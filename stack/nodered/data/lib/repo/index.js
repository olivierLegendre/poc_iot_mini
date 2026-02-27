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

  if (p.referenceHints && typeof p.referenceHints === 'object') {
    meta.reference_hints = p.referenceHints;
  }

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

function buildDeviceReferenceSuggestionQuery(msg) {
  const payload = (msg && typeof msg.payload === 'object' && msg.payload) ? msg.payload : {};
  const params = [];
  const filters = [];

  if (payload.network === 'zigbee' || payload.network === 'lorawan') {
    params.push(payload.network);
    filters.push(`d.network = $${params.length}`);
  }

  if (payload.only_unlinked === true) {
    filters.push('d.device_reference_id IS NULL');
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

  msg.query = `
WITH device_base AS (
  SELECT
    d.id AS device_id,
    d.network,
    d.external_id,
    d.display_name,
    d.device_reference_id,
    NULLIF(BTRIM(d.meta->'reference_hints'->'zigbee'->>'definition_vendor'), '') AS zigbee_vendor,
    NULLIF(BTRIM(d.meta->'reference_hints'->'zigbee'->>'definition_model'), '') AS zigbee_model,
    NULLIF(BTRIM(d.meta->'reference_hints'->'zigbee'->>'friendly_name'), '') AS zigbee_friendly_name,
    NULLIF(BTRIM(d.meta->'reference_hints'->'zigbee'->>'model_id'), '') AS zigbee_model_id,
    NULLIF(BTRIM(d.meta->'reference_hints'->'zigbee'->>'manufacturer'), '') AS zigbee_manufacturer,
    NULLIF(BTRIM(d.meta->'reference_hints'->'lorawan'->>'device_profile_name'), '') AS lora_profile_name,
    NULLIF(BTRIM(d.meta->'reference_hints'->'lorawan'->>'device_profile_id'), '') AS lora_profile_id,
    NULLIF(BTRIM(d.meta->'reference_hints'->'lorawan'->>'device_name'), '') AS lora_device_name
  FROM poc.devices d
  ${whereClause}
), suggestion_base AS (
  SELECT
    db.device_id,
    db.network,
    db.external_id,
    db.display_name,
    db.device_reference_id,
    CASE
      WHEN db.network = 'zigbee' AND db.zigbee_vendor IS NOT NULL AND db.zigbee_model IS NOT NULL
        THEN lower(db.zigbee_vendor) || '_' || lower(db.zigbee_model)
      WHEN db.network = 'lorawan' AND db.lora_profile_name IS NOT NULL
        THEN lower(db.lora_profile_name)
      ELSE NULL
    END AS suggested_reference_key,
    CASE
      WHEN db.network = 'zigbee'
        THEN db.zigbee_vendor IS NOT NULL AND db.zigbee_model IS NOT NULL
      WHEN db.network = 'lorawan'
        THEN db.lora_profile_name IS NOT NULL
      ELSE FALSE
    END AS key_ready,
    CASE
      WHEN db.network = 'zigbee' AND db.zigbee_vendor IS NULL AND db.zigbee_model IS NULL
        THEN 'missing definition.vendor and definition.model from zigbee reference hints'
      WHEN db.network = 'zigbee' AND db.zigbee_vendor IS NULL
        THEN 'missing definition.vendor from zigbee reference hints'
      WHEN db.network = 'zigbee' AND db.zigbee_model IS NULL
        THEN 'missing definition.model from zigbee reference hints'
      WHEN db.network = 'lorawan' AND db.lora_profile_name IS NULL
        THEN 'missing deviceProfileName from lorawan reference hints'
      ELSE NULL
    END AS blocked_reason,
    jsonb_build_object(
      'zigbee_vendor', db.zigbee_vendor,
      'zigbee_model', db.zigbee_model,
      'zigbee_model_id', db.zigbee_model_id,
      'zigbee_manufacturer', db.zigbee_manufacturer,
      'zigbee_friendly_name', db.zigbee_friendly_name,
      'lorawan_profile_name', db.lora_profile_name,
      'lorawan_profile_id', db.lora_profile_id,
      'lorawan_device_name', db.lora_device_name
    ) AS evidence
  FROM device_base db
)
SELECT
  sb.device_id,
  sb.network,
  sb.external_id,
  sb.display_name,
  sb.device_reference_id AS current_reference_id,
  dr_current.reference_key AS current_reference_key,
  dr_current.vendor AS current_reference_vendor,
  dr_current.model AS current_reference_model,
  sb.suggested_reference_key,
  sb.key_ready,
  sb.blocked_reason,
  sb.evidence,
  dr_match.id AS matched_reference_id,
  dr_match.reference_key AS matched_reference_key,
  dr_match.vendor AS matched_reference_vendor,
  dr_match.model AS matched_reference_model
FROM suggestion_base sb
LEFT JOIN poc.device_reference dr_current
  ON dr_current.id = sb.device_reference_id
LEFT JOIN poc.device_reference dr_match
  ON dr_match.network = sb.network
 AND dr_match.reference_key = sb.suggested_reference_key
ORDER BY sb.network, sb.external_id;
`;
  msg.params = params;
  return msg;
}

function buildDeviceReferenceFindByKeyQuery(msg) {
  const input = (msg && msg.deviceReferenceInput && typeof msg.deviceReferenceInput === 'object')
    ? msg.deviceReferenceInput
    : {};

  if (!input.network || !input.reference_key) {
    return null;
  }

  msg.query = `
SELECT
  dr.id,
  dr.network,
  dr.reference_key,
  dr.vendor,
  dr.model,
  dr.active_mapping_version,
  dr.mapping_file_path,
  dr.meta->>'reference_display_name' AS reference_display_name,
  dr.meta,
  dr.created_at,
  dr.updated_at
FROM poc.device_reference dr
WHERE dr.network = $1
  AND dr.reference_key = $2
LIMIT 1;
`;
  msg.params = [input.network, input.reference_key];
  return msg;
}

function buildDeviceReferenceGetByIdQuery(msg) {
  const input = (msg && msg.deviceReferenceInput && typeof msg.deviceReferenceInput === 'object')
    ? msg.deviceReferenceInput
    : {};

  if (!Number.isInteger(input.id) || input.id <= 0) {
    return null;
  }

  msg.query = `
SELECT
  dr.id,
  dr.network,
  dr.reference_key,
  dr.vendor,
  dr.model,
  dr.active_mapping_version,
  dr.mapping_file_path,
  dr.meta->>'reference_display_name' AS reference_display_name,
  dr.meta,
  dr.created_at,
  dr.updated_at
FROM poc.device_reference dr
WHERE dr.id = $1
LIMIT 1;
`;
  msg.params = [input.id];
  return msg;
}

function buildDeviceReferenceCreateQuery(msg) {
  const input = (msg && msg.deviceReferenceInput && typeof msg.deviceReferenceInput === 'object')
    ? msg.deviceReferenceInput
    : {};

  if (!input.network || !input.reference_key || !input.model || !input.reference_display_name) {
    return null;
  }

  const capabilities = Array.isArray(input.capabilities) ? input.capabilities : [];
  const capabilityRows = capabilities.map((capability) => ({ capability }));

  const meta = {
    ...(input.meta || {}),
    reference_display_name: input.reference_display_name
  };

  msg.query = `
WITH inserted AS (
  INSERT INTO poc.device_reference (
    network,
    reference_key,
    vendor,
    model,
    active_mapping_version,
    mapping_file_path,
    meta,
    created_at,
    updated_at
  )
  VALUES ($1, $2, $3, $4, 1, $5, COALESCE($6::jsonb, '{}'::jsonb), now(), now())
  RETURNING
    id,
    network,
    reference_key,
    vendor,
    model,
    active_mapping_version,
    mapping_file_path,
    meta,
    created_at,
    updated_at
), input_rows AS (
  SELECT DISTINCT capability
  FROM jsonb_to_recordset(COALESCE($7::jsonb, '[]'::jsonb))
  AS r(capability text)
  WHERE capability IN ('actuator', 'periodic_sensor', 'event_driven_sensor')
), inserted_caps AS (
  INSERT INTO poc.device_reference_capability (device_reference_id, capability, created_at)
  SELECT inserted.id, input_rows.capability, now()
  FROM inserted
  JOIN input_rows ON TRUE
  ON CONFLICT (device_reference_id, capability) DO NOTHING
  RETURNING capability
), caps AS (
  SELECT
    inserted.id AS device_reference_id,
    COALESCE(
      array_agg(inserted_caps.capability ORDER BY inserted_caps.capability) FILTER (WHERE inserted_caps.capability IS NOT NULL),
      ARRAY[]::text[]
    ) AS capabilities
  FROM inserted
  LEFT JOIN inserted_caps ON TRUE
  GROUP BY inserted.id
)
SELECT
  inserted.id,
  inserted.network,
  inserted.reference_key,
  inserted.vendor,
  inserted.model,
  inserted.active_mapping_version,
  inserted.mapping_file_path,
  inserted.meta->>'reference_display_name' AS reference_display_name,
  inserted.meta,
  caps.capabilities,
  inserted.created_at,
  inserted.updated_at
FROM inserted
JOIN caps ON caps.device_reference_id = inserted.id;
`;
  msg.params = [
    input.network,
    input.reference_key,
    input.vendor || null,
    input.model,
    input.mapping_file_path || null,
    JSON.stringify(meta),
    JSON.stringify(capabilityRows)
  ];
  return msg;
}

function buildDeviceReferenceUpdateQuery(msg) {
  const input = (msg && msg.deviceReferenceInput && typeof msg.deviceReferenceInput === 'object')
    ? msg.deviceReferenceInput
    : {};

  if (!Number.isInteger(input.id) || input.id <= 0 || !input.reference_display_name) {
    return null;
  }

  const capabilitiesProvided = Array.isArray(input.capabilities);
  const capabilityRows = capabilitiesProvided
    ? input.capabilities.map((capability) => ({ capability }))
    : [];

  const meta = {
    ...(input.meta || {}),
    reference_display_name: input.reference_display_name
  };

  msg.query = `
WITH updated AS (
  UPDATE poc.device_reference
  SET
    vendor = COALESCE($2, vendor),
    model = COALESCE($3, model),
    mapping_file_path = COALESCE($4, mapping_file_path),
    meta = COALESCE(poc.device_reference.meta, '{}'::jsonb) || COALESCE($5::jsonb, '{}'::jsonb),
    updated_at = now()
  WHERE id = $1
  RETURNING
    id,
    network,
    reference_key,
    vendor,
    model,
    active_mapping_version,
    mapping_file_path,
    meta,
    created_at,
    updated_at
), removed AS (
  DELETE FROM poc.device_reference_capability
  WHERE device_reference_id = $1
    AND $6::boolean
  RETURNING id
), input_rows AS (
  SELECT DISTINCT capability
  FROM jsonb_to_recordset(COALESCE($7::jsonb, '[]'::jsonb))
  AS r(capability text)
  WHERE capability IN ('actuator', 'periodic_sensor', 'event_driven_sensor')
), inserted_caps AS (
  INSERT INTO poc.device_reference_capability (device_reference_id, capability, created_at)
  SELECT $1, input_rows.capability, now()
  FROM input_rows
  WHERE $6::boolean
  ON CONFLICT (device_reference_id, capability) DO NOTHING
  RETURNING capability
), cap_touch AS (
  SELECT
    COALESCE((SELECT count(*) FROM removed), 0) AS removed_count,
    COALESCE((SELECT count(*) FROM inserted_caps), 0) AS inserted_count
), existing_caps AS (
  SELECT COALESCE(array_agg(c.capability ORDER BY c.capability), ARRAY[]::text[]) AS capabilities
  FROM poc.device_reference_capability c
  WHERE c.device_reference_id = $1
), caps AS (
  SELECT
    CASE
      WHEN $6::boolean THEN COALESCE((SELECT array_agg(capability ORDER BY capability) FROM input_rows), ARRAY[]::text[])
      ELSE existing_caps.capabilities
    END AS capabilities
  FROM existing_caps
  CROSS JOIN cap_touch
)
SELECT
  updated.id,
  updated.network,
  updated.reference_key,
  updated.vendor,
  updated.model,
  updated.active_mapping_version,
  updated.mapping_file_path,
  updated.meta->>'reference_display_name' AS reference_display_name,
  updated.meta,
  caps.capabilities,
  updated.created_at,
  updated.updated_at
FROM updated
JOIN caps ON TRUE;
`;
  msg.params = [
    input.id,
    input.vendor || null,
    input.model || null,
    input.mapping_file_path || null,
    JSON.stringify(meta),
    capabilitiesProvided,
    JSON.stringify(capabilityRows)
  ];
  return msg;
}

function buildDeviceReferenceListQuery(msg) {
  const payload = (msg && typeof msg.payload === 'object' && msg.payload) ? msg.payload : {};
  const params = [];
  const filters = [];

  if (payload.network === 'zigbee' || payload.network === 'lorawan') {
    params.push(payload.network);
    filters.push(`dr.network = $${params.length}`);
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

  msg.query = `
WITH caps AS (
  SELECT
    device_reference_id,
    array_agg(capability ORDER BY capability) AS capabilities
  FROM poc.device_reference_capability
  GROUP BY device_reference_id
)
SELECT
  dr.id,
  dr.network,
  dr.reference_key,
  dr.vendor,
  dr.model,
  dr.active_mapping_version,
  dr.mapping_file_path,
  COALESCE(dr.meta->>'reference_display_name', dr.reference_key) AS reference_display_name,
  dr.meta,
  COALESCE(caps.capabilities, ARRAY[]::text[]) AS capabilities,
  dr.created_at,
  dr.updated_at
FROM poc.device_reference dr
LEFT JOIN caps ON caps.device_reference_id = dr.id
${whereClause}
ORDER BY dr.network, COALESCE(dr.meta->>'reference_display_name', dr.reference_key), dr.reference_key;
`;
  msg.params = params;
  return msg;
}

function buildDeviceReferenceMappingFieldsQuery(msg) {
  const input = (msg && msg.deviceReferenceMappingInput && typeof msg.deviceReferenceMappingInput === 'object')
    ? msg.deviceReferenceMappingInput
    : {};

  if (!Number.isInteger(input.id) || input.id <= 0) {
    return null;
  }

  msg.query = `
WITH ref AS (
  SELECT
    dr.id,
    dr.network,
    dr.reference_key,
    dr.active_mapping_version
  FROM poc.device_reference dr
  WHERE dr.id = $1
), dev AS (
  SELECT d.id
  FROM poc.devices d
  WHERE d.device_reference_id = $1
), cand_ranked AS (
  SELECT
    c.id,
    c.source_path,
    c.inferred_data_type,
    c.sample_value,
    c.last_seen_at,
    SUM(c.seen_count) OVER (PARTITION BY c.source_path) AS seen_count_total,
    ROW_NUMBER() OVER (
      PARTITION BY c.source_path
      ORDER BY c.last_seen_at DESC NULLS LAST, c.id DESC
    ) AS rn
  FROM poc.device_mapping_candidate c
  JOIN dev ON dev.id = c.device_id
), cand AS (
  SELECT
    source_path,
    inferred_data_type,
    sample_value,
    seen_count_total AS seen_count,
    last_seen_at
  FROM cand_ranked
  WHERE rn = 1
), map AS (
  SELECT
    m.id AS mapping_id,
    m.source_path,
    m.normalized_field,
    m.role,
    m.data_type,
    m.unit,
    m.is_active
  FROM poc.device_reference_mapping m
  JOIN ref ON ref.id = m.device_reference_id
  WHERE m.mapping_version = ref.active_mapping_version
), combined AS (
  SELECT
    COALESCE(cand.source_path, map.source_path) AS source_path,
    cand.inferred_data_type,
    cand.sample_value,
    cand.seen_count,
    cand.last_seen_at,
    map.mapping_id,
    map.normalized_field,
    map.role,
    map.data_type,
    map.unit,
    map.is_active
  FROM cand
  FULL OUTER JOIN map ON map.source_path = cand.source_path
)
SELECT
  ref.id AS reference_id,
  ref.network,
  ref.reference_key,
  ref.active_mapping_version,
  combined.source_path,
  combined.inferred_data_type,
  combined.sample_value,
  combined.seen_count,
  combined.last_seen_at,
  combined.mapping_id,
  combined.normalized_field,
  combined.role,
  combined.data_type,
  combined.unit,
  combined.is_active
FROM ref
LEFT JOIN combined ON TRUE
ORDER BY combined.source_path NULLS LAST;
`;
  msg.params = [input.id];
  return msg;
}

function buildDeviceReferenceMappingsReplaceQuery(msg) {
  const input = (msg && msg.deviceReferenceMappingInput && typeof msg.deviceReferenceMappingInput === 'object')
    ? msg.deviceReferenceMappingInput
    : {};
  const mappings = Array.isArray(input.mappings) ? input.mappings : [];

  if (!Number.isInteger(input.id) || input.id <= 0) {
    return null;
  }

  msg.query = `
WITH ref AS (
  SELECT
    dr.id,
    dr.active_mapping_version
  FROM poc.device_reference dr
  WHERE dr.id = $1
), deleted AS (
  DELETE FROM poc.device_reference_mapping m
  USING ref
  WHERE m.device_reference_id = ref.id
    AND m.mapping_version = ref.active_mapping_version
  RETURNING m.id
), deleted_touch AS (
  SELECT COALESCE(count(*), 0) AS deleted_count
  FROM deleted
), input_rows AS (
  SELECT *
  FROM jsonb_to_recordset(COALESCE($2::jsonb, '[]'::jsonb))
  AS r(
    source_path text,
    normalized_field text,
    role text,
    data_type text,
    unit text,
    is_active boolean,
    transform_hint text,
    meta jsonb
  )
), inserted AS (
  INSERT INTO poc.device_reference_mapping (
    device_reference_id,
    mapping_version,
    normalized_field,
    source_path,
    data_type,
    unit,
    role,
    is_active,
    transform_hint,
    meta,
    created_at,
    updated_at
  )
  SELECT
    ref.id,
    ref.active_mapping_version,
    input_rows.normalized_field,
    input_rows.source_path,
    input_rows.data_type,
    NULLIF(input_rows.unit, ''),
    input_rows.role,
    COALESCE(input_rows.is_active, true),
    NULLIF(input_rows.transform_hint, ''),
    COALESCE(input_rows.meta, '{}'::jsonb),
    now(),
    now()
  FROM ref
  JOIN input_rows ON TRUE
  CROSS JOIN deleted_touch
  RETURNING
    id,
    source_path,
    normalized_field,
    role,
    data_type,
    unit,
    is_active
)
SELECT
  ref.id AS reference_id,
  COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', inserted.id,
          'source_path', inserted.source_path,
          'normalized_field', inserted.normalized_field,
          'role', inserted.role,
          'data_type', inserted.data_type,
          'unit', inserted.unit,
          'is_active', inserted.is_active
        )
        ORDER BY inserted.source_path
      )
      FROM inserted
    ),
    '[]'::jsonb
  ) AS mappings
FROM ref;
`;
  msg.params = [
    input.id,
    JSON.stringify(mappings)
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
  msg.query = `SELECT d.id AS device_id,
       d.network,
       d.external_id,
       d.display_name,
       d.last_seen_at,
       d.device_reference_id,
       dr.reference_key AS reference_key,
       COALESCE(dr.meta->>'reference_display_name', dr.reference_key) AS reference_display_name,
       t.ts AS last_ts,
       t.metrics
FROM poc.devices d
LEFT JOIN poc.device_reference dr ON dr.id = d.device_reference_id
LEFT JOIN poc.latest_telemetry t ON t.device_id = d.id
ORDER BY d.network, d.external_id;`;
  msg.params = [];
  return msg;
}

function buildDeviceAssignReferenceQuery(msg) {
  const input = (msg && msg.deviceReferenceLinkInput && typeof msg.deviceReferenceLinkInput === 'object')
    ? msg.deviceReferenceLinkInput
    : {};

  const hasDeviceId = Number.isInteger(input.device_id) && input.device_id > 0;
  const hasReferenceId = Number.isInteger(input.reference_id) && input.reference_id > 0;

  if (!hasDeviceId || !hasReferenceId) {
    return null;
  }

  msg.query = `
UPDATE poc.devices d
SET device_reference_id = $2
WHERE d.id = $1
RETURNING
  d.id AS device_id,
  d.network,
  d.external_id,
  d.display_name,
  d.device_reference_id;
`;
  msg.params = [input.device_id, input.reference_id];
  return msg;
}

function buildActuatorStatusQuery(msg) {
  msg.query = `WITH actuator_devices AS (
  SELECT
    d.id,
    d.device_reference_id,
    d.network,
    d.external_id,
    d.display_name,
    dr.reference_key,
    COALESCE(dr.meta->>'reference_display_name', dr.reference_key) AS reference_display_name,
    dr.active_mapping_version,
    EXISTS (
      SELECT 1
      FROM poc.device_reference_mapping drm
      JOIN poc.device_reference drx ON drx.id = drm.device_reference_id
      WHERE drx.id = d.device_reference_id
        AND drm.mapping_version = drx.active_mapping_version
        AND drm.is_active = true
        AND drm.role = 'actuation'
    ) AS has_actuation
  FROM poc.devices d
  JOIN poc.device_reference dr ON dr.id = d.device_reference_id
  LEFT JOIN poc.device_reference_capability cap
    ON cap.device_reference_id = dr.id
   AND cap.capability = 'actuator'
  LEFT JOIN poc.device_reference_mapping drm
    ON drm.device_reference_id = dr.id
   AND drm.mapping_version = dr.active_mapping_version
   AND drm.is_active = true
   AND drm.role = 'actuation'
  WHERE cap.device_reference_id IS NOT NULL
     OR drm.id IS NOT NULL
  GROUP BY
    d.id,
    d.device_reference_id,
    d.network,
    d.external_id,
    d.display_name,
    dr.reference_key,
    dr.meta,
    dr.active_mapping_version
)
SELECT
  ad.network,
  ad.external_id,
  ad.display_name,
  ad.reference_key,
  ad.reference_display_name,
  ad.has_actuation,
  t.ts,
  t.metrics,
  COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', map.id,
        'source_path', map.source_path,
        'normalized_field', map.normalized_field,
        'role', map.role,
        'data_type', map.data_type
      )
      ORDER BY map.id
    ) FILTER (WHERE map.id IS NOT NULL),
    '[]'::jsonb
  ) AS mappings
FROM actuator_devices ad
LEFT JOIN poc.latest_telemetry t ON t.device_id = ad.id
LEFT JOIN poc.device_reference_mapping map
  ON map.device_reference_id = ad.device_reference_id
 AND map.mapping_version = ad.active_mapping_version
 AND map.is_active = true
 AND map.role IN ('actuation', 'status')
GROUP BY
  ad.id,
  ad.network,
  ad.external_id,
  ad.display_name,
  ad.reference_key,
  ad.reference_display_name,
  ad.has_actuation,
  t.ts,
  t.metrics
ORDER BY ad.reference_display_name, ad.network, ad.external_id;`;
  msg.params = [];
  return msg;
}

function buildToggleLookupQuery(msg) {
  const id = msg.payload;
  msg.targetDevice = id;
  msg.query = `SELECT
  d.network,
  d.external_id,
  d.display_name,
  d.meta,
  t.metrics,
  COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', drm.id,
        'source_path', drm.source_path,
        'normalized_field', drm.normalized_field,
        'role', drm.role,
        'data_type', drm.data_type
      )
      ORDER BY drm.id
    ) FILTER (WHERE drm.id IS NOT NULL),
    '[]'::jsonb
  ) AS mappings
FROM poc.devices d
LEFT JOIN poc.latest_telemetry t ON t.device_id = d.id
LEFT JOIN poc.device_reference dr ON dr.id = d.device_reference_id
LEFT JOIN poc.device_reference_mapping drm
  ON drm.device_reference_id = dr.id
 AND drm.mapping_version = dr.active_mapping_version
 AND drm.is_active = true
 AND drm.role IN ('actuation', 'status')
WHERE d.external_id = $1
GROUP BY d.id, d.network, d.external_id, d.display_name, d.meta, t.metrics
LIMIT 1;`;
  msg.params = [id];
  return msg;
}

function buildEventSensorChangesQuery(msg) {
  msg.query = `WITH event_map AS (
  SELECT
    d.id AS device_id,
    d.external_id,
    d.display_name,
    lt.ts AS last_ts,
    lt.metrics AS last_metrics,
    drm.source_path,
    drm.normalized_field AS metric_label
  FROM poc.devices d
  JOIN poc.device_reference dr ON dr.id = d.device_reference_id
  JOIN poc.device_reference_mapping drm
    ON drm.device_reference_id = dr.id
   AND drm.mapping_version = dr.active_mapping_version
   AND drm.is_active = true
   AND drm.role = 'event'
  LEFT JOIN poc.latest_telemetry lt ON lt.device_id = d.id
), latest AS (
  SELECT DISTINCT
    device_id,
    external_id,
    display_name,
    last_ts,
    last_metrics
  FROM event_map
), relevant AS (
  SELECT
    em.device_id,
    em.external_id,
    em.display_name,
    em.source_path,
    em.metric_label,
    m.ts,
    COALESCE(
      m.value_text,
      CASE
        WHEN m.value_boolean IS NULL THEN NULL
        WHEN m.value_boolean THEN 'true'
        ELSE 'false'
      END,
      CASE
        WHEN m.value_number IS NULL THEN NULL
        ELSE m.value_number::text
      END,
      m.value_json::text
    ) AS metric_value
  FROM event_map em
  JOIN poc.metrics m
    ON m.device_id = em.device_id
   AND m.source_path = em.source_path
), diff AS (
  SELECT
    device_id,
    external_id,
    metric_label AS metric_key,
    source_path,
    ts,
    lag(metric_value) OVER (PARTITION BY device_id, source_path ORDER BY ts) AS old_value,
    metric_value AS new_value
  FROM relevant
  WHERE metric_value IS NOT NULL
), ranked AS (
  SELECT
    *,
    row_number() OVER (PARTITION BY device_id ORDER BY ts DESC) AS rn
  FROM diff
  WHERE old_value IS NOT NULL
    AND old_value <> new_value
), changes AS (
  SELECT
    device_id,
    metric_key,
    old_value,
    new_value,
    ts
  FROM ranked
  WHERE rn <= 5
)
SELECT
  l.external_id,
  l.display_name,
  l.last_ts,
  l.last_metrics,
  c.metric_key,
  c.old_value,
  c.new_value,
  c.ts
FROM latest l
LEFT JOIN changes c
  ON c.device_id = l.device_id
ORDER BY l.external_id, c.ts DESC NULLS LAST;`;
  msg.params = [];
  return msg;
}

function buildPeriodicMetricsQuery(msg, flow) {
  const rangeMap = {
    '1h': '1 hour',
    '6h': '6 hours',
    '24h': '24 hours',
    '7d': '7 days'
  };
  const bucketMap = {
    '1 minute': '1 minute',
    '5 minutes': '5 minutes',
    '15 minutes': '15 minutes',
    '1 hour': '1 hour'
  };
  const autoBucketByRange = {
    '1h': '1 minute',
    '6h': '5 minutes',
    '24h': '15 minutes',
    '7d': '1 hour'
  };

  const selectedRange = flow.get('periodic_range') || '1h';
  const selectedBucket = flow.get('periodic_bucket') || 'auto';
  const interval = rangeMap[selectedRange] || rangeMap['1h'];
  const bucketKey = selectedBucket === 'auto'
    ? (autoBucketByRange[selectedRange] || autoBucketByRange['1h'])
    : selectedBucket;
  const bucket = bucketMap[bucketKey] || bucketMap['1 minute'];

  msg.periodicRange = rangeMap[selectedRange] ? selectedRange : '1h';
  msg.periodicBucket = selectedBucket;
  msg.periodicBucketResolved = bucket;
  msg.query = `WITH mapped AS (
  SELECT
    d.id AS device_id,
    d.external_id AS device_external_id,
    COALESCE(d.display_name, d.external_id) AS device_label,
    drm.source_path,
    drm.normalized_field AS metric_name,
    NULLIF(BTRIM(drm.unit), '') AS unit,
    lower(COALESCE(drm.data_type, '')) AS metric_data_type
  FROM poc.devices d
  JOIN poc.device_reference dr ON dr.id = d.device_reference_id
  JOIN poc.device_reference_capability cap
    ON cap.device_reference_id = dr.id
   AND cap.capability = 'periodic_sensor'
  JOIN poc.device_reference_mapping drm
    ON drm.device_reference_id = dr.id
   AND drm.mapping_version = dr.active_mapping_version
   AND drm.is_active = true
   AND drm.role = 'metric'
  WHERE lower(COALESCE(drm.data_type, '')) IN ('number', 'integer', 'boolean', 'text')
), bucketed AS (
  SELECT
    mapped.device_id,
    mapped.device_external_id,
    mapped.device_label,
    mapped.source_path,
    mapped.metric_name,
    mapped.unit,
    mapped.metric_data_type,
    date_bin(interval '${bucket}', m.ts, TIMESTAMPTZ '1970-01-01') AS bucket,
    avg(m.value_number) FILTER (
      WHERE mapped.metric_data_type IN ('number', 'integer')
    ) AS value_number,
    (
      array_agg(m.value_boolean ORDER BY m.ts DESC) FILTER (
        WHERE mapped.metric_data_type = 'boolean'
          AND m.value_boolean IS NOT NULL
      )
    )[1] AS value_boolean,
    (
      array_agg(m.value_text ORDER BY m.ts DESC) FILTER (
        WHERE mapped.metric_data_type = 'text'
          AND m.value_text IS NOT NULL
      )
    )[1] AS value_text
  FROM poc.metrics m
  JOIN mapped
    ON mapped.device_id = m.device_id
   AND mapped.source_path = m.source_path
  WHERE m.ts >= now() - interval '${interval}'
    AND (
      (mapped.metric_data_type IN ('number', 'integer') AND m.value_number IS NOT NULL)
      OR (mapped.metric_data_type = 'boolean' AND m.value_boolean IS NOT NULL)
      OR (mapped.metric_data_type = 'text' AND m.value_text IS NOT NULL)
    )
  GROUP BY
    mapped.device_id,
    mapped.device_external_id,
    mapped.device_label,
    mapped.source_path,
    mapped.metric_name,
    mapped.unit,
    mapped.metric_data_type,
    date_bin(interval '${bucket}', m.ts, TIMESTAMPTZ '1970-01-01')
)
SELECT
  mapped.device_external_id,
  mapped.device_label,
  mapped.metric_name,
  mapped.unit,
  mapped.metric_data_type,
  now() AS query_now,
  now() - interval '${interval}' AS range_start,
  bucketed.bucket,
  bucketed.value_number,
  bucketed.value_boolean,
  bucketed.value_text
FROM mapped
LEFT JOIN bucketed
  ON bucketed.device_id = mapped.device_id
 AND bucketed.source_path = mapped.source_path
 AND bucketed.unit IS NOT DISTINCT FROM mapped.unit
 AND bucketed.metric_data_type = mapped.metric_data_type
ORDER BY mapped.device_label, mapped.metric_name, mapped.metric_data_type, bucketed.bucket NULLS LAST;`;
  msg.params = [];
  return msg;
}

function buildBatteryStatusQuery(msg) {
  msg.query = `SELECT
  d.external_id,
  d.display_name,
  d.network,
  t.ts,
  t.metrics,
  dr.meta->>'power_source' AS reference_power_source,
  EXISTS (
    SELECT 1
    FROM poc.device_reference_mapping drm
    WHERE drm.device_reference_id = dr.id
      AND drm.mapping_version = dr.active_mapping_version
      AND drm.role = 'battery'
      AND drm.is_active = TRUE
  ) AS has_battery_mapping,
  mapped_battery.ts AS mapped_battery_ts,
  mapped_battery.metric_name AS mapped_battery_metric_name,
  mapped_battery.value_type AS mapped_battery_value_type,
  mapped_battery.value_number AS mapped_battery_value_number,
  mapped_battery.value_text AS mapped_battery_value_text,
  mapped_battery.value_boolean AS mapped_battery_value_boolean,
  mapped_battery.value_json AS mapped_battery_value_json,
  mapped_battery.unit AS mapped_battery_unit,
  mapped_battery.data_type AS mapped_battery_data_type
FROM poc.devices d
LEFT JOIN poc.latest_telemetry t
  ON t.device_id = d.id
LEFT JOIN poc.device_reference dr
  ON dr.id = d.device_reference_id
LEFT JOIN LATERAL (
  SELECT
    m.ts,
    m.metric_name,
    m.value_type,
    m.value_number,
    m.value_text,
    m.value_boolean,
    m.value_json,
    m.unit,
    drm.data_type
  FROM poc.device_reference_mapping drm
  JOIN poc.metrics m
    ON m.mapping_id = drm.id
   AND m.device_id = d.id
  WHERE drm.device_reference_id = dr.id
    AND drm.mapping_version = dr.active_mapping_version
    AND drm.role = 'battery'
    AND drm.is_active = TRUE
  ORDER BY m.ts DESC
  LIMIT 1
) mapped_battery ON TRUE
ORDER BY d.network, d.external_id;`;
  msg.params = [];
  return msg;
}

module.exports = {
  devices: {
    buildUpsertQuery: buildDeviceUpsertQuery,
    buildAssignReferenceQuery: buildDeviceAssignReferenceQuery
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
  deviceReference: {
    buildSuggestionQuery: buildDeviceReferenceSuggestionQuery,
    buildFindByKeyQuery: buildDeviceReferenceFindByKeyQuery,
    buildGetByIdQuery: buildDeviceReferenceGetByIdQuery,
    buildCreateQuery: buildDeviceReferenceCreateQuery,
    buildUpdateQuery: buildDeviceReferenceUpdateQuery,
    buildListQuery: buildDeviceReferenceListQuery
  },
  deviceReferenceMapping: {
    buildFieldsQuery: buildDeviceReferenceMappingFieldsQuery,
    buildReplaceQuery: buildDeviceReferenceMappingsReplaceQuery
  },
  dashboard: {
    buildActivityCompleteQuery,
    buildAllDevicesQuery,
    buildActuatorStatusQuery,
    buildToggleLookupQuery,
    buildEventSensorChangesQuery,
    buildPeriodicMetricsQuery,
    buildBatteryStatusQuery
  }
};
