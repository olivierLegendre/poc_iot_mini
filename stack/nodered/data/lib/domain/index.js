'use strict';

const { getDeviceReferenceSuggestionMessage } = require('./messages');

function isoNow() {
  return new Date().toISOString();
}

function asIso(value) {
  if (!value) return isoNow();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? isoNow() : new Date(parsed).toISOString();
}

function isHex16(value) {
  return typeof value === 'string' && /^[0-9a-f]{16}$/i.test(value);
}

function isIeeeAddress(value) {
  return typeof value === 'string' && /^0x[0-9a-f]{16}$/i.test(value);
}

function canonicalIeee(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (isIeeeAddress(v)) return v;
  if (isHex16(v)) return '0x' + v;
  return null;
}

function cleanString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRetainedMessage(msg) {
  const value = msg && msg.retain;
  return value === true || value === 1 || value === '1' || value === 'true';
}

function normalizeAvailabilityValue(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const text = String(value).trim().toLowerCase();
  if (text === 'online' || text === 'offline') {
    return text;
  }
  return null;
}

function availabilityFromPayload(payload, rawPayload) {
  const candidates = [
    payload && payload.availability,
    payload && payload.state,
    payload && payload.status,
    payload && payload.raw,
    rawPayload
  ];
  for (const value of candidates) {
    const normalized = normalizeAvailabilityValue(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function mergeZigbeeReferenceHint(current, incoming) {
  const base = (current && typeof current === 'object') ? { ...current } : {};
  if (!incoming || typeof incoming !== 'object') {
    base.key_ready = Boolean(base.definition_vendor && base.definition_model);
    return base;
  }

  for (const [key, value] of Object.entries(incoming)) {
    if (value !== null && value !== undefined) {
      base[key] = value;
    }
  }

  base.key_ready = Boolean(base.definition_vendor && base.definition_model);
  return base;
}

function buildZigbeeReferenceHint(device) {
  const src = (device && typeof device === 'object') ? device : {};
  const definition = (src.definition && typeof src.definition === 'object') ? src.definition : {};
  const ieee = canonicalIeee(src.ieee_address || src.ieeeAddr);

  if (!ieee) {
    return null;
  }

  return {
    ieee_address: ieee,
    friendly_name: cleanString(src.friendly_name),
    definition_vendor: cleanString(definition.vendor),
    definition_model: cleanString(definition.model),
    manufacturer: cleanString(src.manufacturer),
    model_id: cleanString(src.model_id)
  };
}

function upsertZigbeeReferenceHint(cache, hint) {
  if (!hint || !hint.ieee_address) {
    return false;
  }

  const ieee = hint.ieee_address;
  const current = cache[ieee];
  const merged = mergeZigbeeReferenceHint(current, hint);
  const changed = JSON.stringify(current || {}) !== JSON.stringify(merged);

  if (changed) {
    cache[ieee] = merged;
  }
  return changed;
}

function normalizeMqtt(msg, flow) {
  const topic = msg.topic || '';
  const rawPayload = msg.payload;
  const payload = (typeof rawPayload === 'object' && rawPayload) ? rawPayload : { raw: rawPayload };
  const retained = isRetainedMessage(msg);
  const zigbeeByFriendly = flow.get('zigbeeByFriendly') || {};
  const zigbeeReferenceByIeee = flow.get('zigbeeReferenceByIeee') || {};

  const out = {
    source: 'unknown',
    deviceId: 'unknown',
    displayName: null,
    eventType: 'unknown',
    ts: isoNow(),
    topic,
    metrics: {},
    referenceHints: null,
    raw: payload
  };

  if (topic === 'zigbee2mqtt/bridge/devices' && Array.isArray(payload)) {
    let friendlyChanged = false;
    let referenceChanged = false;

    for (const device of payload) {
      const ieee = canonicalIeee(device && (device.ieee_address || device.ieeeAddr));
      const friendly = device && device.friendly_name;
      if (ieee && typeof friendly === 'string' && friendly.length > 0) {
        if (zigbeeByFriendly[friendly] !== ieee) {
          zigbeeByFriendly[friendly] = ieee;
          friendlyChanged = true;
        }
      }

      const referenceHint = buildZigbeeReferenceHint(device);
      if (upsertZigbeeReferenceHint(zigbeeReferenceByIeee, referenceHint)) {
        referenceChanged = true;
      }
    }

    if (friendlyChanged) {
      flow.set('zigbeeByFriendly', zigbeeByFriendly);
    }
    if (referenceChanged) {
      flow.set('zigbeeReferenceByIeee', zigbeeReferenceByIeee);
    }
    return null;
  }

  if (topic.startsWith('zigbee2mqtt/bridge/event')) {
    const data = (payload && payload.data) || {};
    const ieee = canonicalIeee(data.ieee_address || data.ieeeAddr);
    const friendly = data.friendly_name;
    let friendlyChanged = false;
    let changed = false;

    if (ieee && typeof friendly === 'string' && friendly.length > 0) {
      if (zigbeeByFriendly[friendly] !== ieee) {
        zigbeeByFriendly[friendly] = ieee;
        friendlyChanged = true;
      }
    }

    const referenceHint = buildZigbeeReferenceHint(data);
    if (upsertZigbeeReferenceHint(zigbeeReferenceByIeee, referenceHint)) {
      changed = true;
    }

    if (changed) {
      flow.set('zigbeeReferenceByIeee', zigbeeReferenceByIeee);
    }

    if (friendlyChanged) {
      flow.set('zigbeeByFriendly', zigbeeByFriendly);
    }
    return null;
  }

  // Retained MQTT payloads are replayed on reconnect and should not update live status.
  if (retained && (topic.startsWith('zigbee2mqtt/') || topic.startsWith('application/'))) {
    return null;
  }

  if (topic.startsWith('zigbee2mqtt/')) {
    const parts = topic.split('/');
    if (parts.length >= 2 && parts[1] !== 'bridge') {
      const topicDevice = parts[1];
      const isAvailabilityTopic = parts.length >= 3 && parts[2] === 'availability';
      let ieee = canonicalIeee(payload.ieee_address || payload.ieeeAddr);
      if (!ieee && isIeeeAddress(topicDevice)) ieee = topicDevice.toLowerCase();
      if (!ieee && zigbeeByFriendly[topicDevice]) ieee = zigbeeByFriendly[topicDevice];

      if (!ieee) {
        return null;
      }

      if (!isIeeeAddress(topicDevice)) {
        zigbeeByFriendly[topicDevice] = ieee;
        flow.set('zigbeeByFriendly', zigbeeByFriendly);
      }

      out.source = 'zigbee';
      out.deviceId = ieee;
      out.displayName = isIeeeAddress(topicDevice) ? (payload.friendly_name || topicDevice) : topicDevice;
      out.eventType = isAvailabilityTopic ? 'availability' : 'state';
      if (isAvailabilityTopic) {
        const availability = availabilityFromPayload(payload, rawPayload);
        if (!availability) {
          return null;
        }
        out.metrics = { availability };
        out.ts = isoNow();
      } else {
        out.metrics = payload;
        out.ts = asIso(payload.last_seen);
      }

      const payloadReferenceHint = buildZigbeeReferenceHint({
        ieee_address: ieee,
        friendly_name: out.displayName,
        definition: payload.definition,
        manufacturer: payload.manufacturer,
        model_id: payload.model_id
      });

      if (upsertZigbeeReferenceHint(zigbeeReferenceByIeee, payloadReferenceHint)) {
        flow.set('zigbeeReferenceByIeee', zigbeeReferenceByIeee);
      }

      const resolvedHint = mergeZigbeeReferenceHint(zigbeeReferenceByIeee[ieee], payloadReferenceHint);
      out.referenceHints = { zigbee: resolvedHint };
    }
  }

  if (topic.startsWith('application/')) {
    const parts = topic.split('/');
    if (parts.length >= 6 && parts[2] === 'device' && parts[4] === 'event') {
      const devEui = String((payload.deviceInfo && payload.deviceInfo.devEui) || parts[3] || '').toLowerCase();
      out.source = 'lorawan';
      out.deviceId = devEui;
      out.displayName = (payload.deviceInfo && payload.deviceInfo.deviceName) || devEui;
      out.eventType = parts[5];
      out.metrics = payload;
      out.ts = asIso(payload.time);
      out.referenceHints = {
        lorawan: {
          dev_eui: devEui,
          device_profile_name: cleanString(payload?.deviceInfo?.deviceProfileName),
          device_profile_id: cleanString(payload?.deviceInfo?.deviceProfileId),
          device_name: cleanString(payload?.deviceInfo?.deviceName),
          key_ready: Boolean(cleanString(payload?.deviceInfo?.deviceProfileName))
        }
      };
    }
  }

  if (out.source === 'unknown') {
    return null;
  }

  msg.poc = out;
  return msg;
}

function parseJsonZigbeeTolerant(msg) {
  const p = msg.payload;
  if (typeof p === 'string') {
    const t = p.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        msg.payload = JSON.parse(t);
      } catch (err) {
        return msg;
      }
    }
  }
  return msg;
}

function extractAllFields(msg) {
  const p = msg.poc || {};
  const src = p.metrics;
  if (!src || typeof src !== 'object') {
    return null;
  }

  const out = [];

  function inferType(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    switch (typeof v) {
      case 'number': return Number.isInteger(v) ? 'integer' : 'number';
      case 'boolean': return 'boolean';
      case 'string': return 'text';
      case 'object': return 'object';
      default: return 'unknown';
    }
  }

  function walk(value, path) {
    if (Array.isArray(value)) {
      out.push({
        source_path: path,
        sample_value: value,
        inferred_data_type: 'array'
      });
      for (let i = 0; i < value.length; i++) {
        walk(value[i], path ? `${path}[${i}]` : `[${i}]`);
      }
      return;
    }

    if (value && typeof value === 'object') {
      const keys = Object.keys(value);
      if (path) {
        out.push({
          source_path: path,
          sample_value: value,
          inferred_data_type: 'object'
        });
      }
      for (const k of keys) {
        const next = path ? `${path}.${k}` : k;
        walk(value[k], next);
      }
      return;
    }

    out.push({
      source_path: path,
      sample_value: value,
      inferred_data_type: inferType(value)
    });
  }

  walk(src, '');
  msg.mappingCandidates = out.filter((r) => r.source_path && r.source_path.length > 0);
  if (msg.mappingCandidates.length === 0) {
    return null;
  }
  return msg;
}

function parseObjectLike(value) {
  if (value && typeof value === 'object') {
    return value;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch (err) {
      return null;
    }
  }
  return null;
}

function isTrue(value) {
  return value === true || value === 't' || value === 'true' || value === 1 || value === '1';
}

function formatReferenceSuggestions(msg) {
  const rows = Array.isArray(msg.payload) ? msg.payload : [];

  const out = rows.map((row) => {
    const keyReady = isTrue(row.key_ready);
    const currentRefId = row.current_reference_id;
    const matchedRefId = row.matched_reference_id;
    const hasCurrentRef = currentRefId !== null && currentRefId !== undefined;
    const hasMatchedRef = matchedRefId !== null && matchedRefId !== undefined;
    const sameRef = hasCurrentRef && hasMatchedRef && String(currentRefId) === String(matchedRefId);
    const evidence = parseObjectLike(row.evidence) || {};

    let suggestionStatus = 'blocked';
    const blockedReasonDefault = getDeviceReferenceSuggestionMessage('blocked', 'missing required reference fields');

    if (keyReady) {
      if (sameRef) {
        suggestionStatus = 'already_linked';
      } else if (hasCurrentRef && hasMatchedRef) {
        suggestionStatus = 'suggest_relink';
      } else if (!hasCurrentRef && hasMatchedRef) {
        suggestionStatus = 'suggest_link_existing';
      } else if (hasCurrentRef && !hasMatchedRef) {
        suggestionStatus = 'linked_reference_no_key_match';
      } else {
        suggestionStatus = 'suggest_create_reference';
      }
    }
    const reason = suggestionStatus === 'blocked'
      ? (row.blocked_reason || blockedReasonDefault)
      : getDeviceReferenceSuggestionMessage(suggestionStatus, blockedReasonDefault);

    return {
      deviceId: row.device_id,
      network: row.network,
      externalId: row.external_id,
      displayName: row.display_name || row.external_id,
      keyReady,
      suggestedReferenceKey: row.suggested_reference_key || null,
      suggestionStatus,
      reason,
      confidence: keyReady ? 1 : 0,
      currentReference: hasCurrentRef ? {
        id: row.current_reference_id,
        key: row.current_reference_key || null,
        vendor: row.current_reference_vendor || null,
        model: row.current_reference_model || null
      } : null,
      matchedReference: hasMatchedRef ? {
        id: row.matched_reference_id,
        key: row.matched_reference_key || null,
        vendor: row.matched_reference_vendor || null,
        model: row.matched_reference_model || null
      } : null,
      evidence
    };
  });

  out.sort((a, b) => {
    const netCmp = String(a.network || '').localeCompare(String(b.network || ''));
    if (netCmp !== 0) return netCmp;
    return String(a.externalId || '').localeCompare(String(b.externalId || ''));
  });

  msg.payload = out;
  return msg;
}

const ALLOWED_DEVICE_REFERENCE_CAPABILITIES = ['actuator', 'periodic_sensor', 'event_driven_sensor'];
const ALLOWED_DEVICE_REFERENCE_CAPABILITIES_SET = new Set(ALLOWED_DEVICE_REFERENCE_CAPABILITIES);
const ALLOWED_DEVICE_REFERENCE_MAPPING_ROLES = ['metric', 'status', 'battery', 'event', 'actuation', 'metadata'];
const ALLOWED_DEVICE_REFERENCE_MAPPING_ROLES_SET = new Set(ALLOWED_DEVICE_REFERENCE_MAPPING_ROLES);
const ALLOWED_DEVICE_REFERENCE_MAPPING_DATA_TYPES = ['number', 'integer', 'boolean', 'text', 'json', 'timestamp'];
const ALLOWED_DEVICE_REFERENCE_MAPPING_DATA_TYPES_SET = new Set(ALLOWED_DEVICE_REFERENCE_MAPPING_DATA_TYPES);

function asPayloadObject(msg) {
  const value = msg && msg.payload;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  return null;
}

function trimmedString(value) {
  return cleanString(value);
}

function lowerTrimmedString(value) {
  const out = trimmedString(value);
  return out ? out.toLowerCase() : null;
}

function parsePositiveInt(value) {
  if (Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string') {
    const s = value.trim();
    if (!/^\d+$/.test(s)) {
      return null;
    }
    const n = Number(s);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  return null;
}

function normalizeMetricFieldToken(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .trim()
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
}

function defaultNormalizedFieldFromSourcePath(sourcePath) {
  const token = normalizeMetricFieldToken(sourcePath || '');
  if (token.length > 0) {
    return token;
  }
  return 'field';
}

function setDeviceReferenceValidationError(msg, code, message, details) {
  msg.deviceReferenceInput = null;
  msg.deviceReferenceValidation = {
    ok: false,
    statusCode: 422,
    code,
    message,
    details: Array.isArray(details) ? details : []
  };
  return msg;
}

function setDeviceReferenceValidationOk(msg, mode, input) {
  msg.deviceReferenceInput = input;
  msg.deviceReferenceValidation = {
    ok: true,
    statusCode: 200,
    mode
  };
  return msg;
}

function setDeviceReferenceMappingValidationError(msg, code, message, details) {
  msg.deviceReferenceMappingInput = null;
  msg.deviceReferenceMappingValidation = {
    ok: false,
    statusCode: 422,
    code,
    message,
    details: Array.isArray(details) ? details : []
  };
  return msg;
}

function setDeviceReferenceMappingValidationOk(msg, input) {
  msg.deviceReferenceMappingInput = input;
  msg.deviceReferenceMappingValidation = {
    ok: true,
    statusCode: 200
  };
  return msg;
}

function normalizeNetwork(networkRaw) {
  const network = lowerTrimmedString(networkRaw);
  if (!network) {
    return { ok: false, code: 'missing_network', message: 'network is required' };
  }

  if (network !== 'zigbee' && network !== 'lorawan') {
    return { ok: false, code: 'invalid_network', message: 'network must be one of: zigbee, lorawan' };
  }
  return { ok: true, value: network };
}

function normalizeCapabilities(capabilitiesRaw) {
  if (capabilitiesRaw === undefined) {
    return { ok: true, provided: false, value: null };
  }

  if (!Array.isArray(capabilitiesRaw)) {
    return {
      ok: false,
      code: 'invalid_capabilities',
      message: 'capabilities must be an array',
      details: [
        {
          field: 'capabilities',
          allowed: ALLOWED_DEVICE_REFERENCE_CAPABILITIES
        }
      ]
    };
  }

  const out = [];
  const seen = new Set();
  for (const capabilityRaw of capabilitiesRaw) {
    const capability = lowerTrimmedString(capabilityRaw);
    if (!capability || !ALLOWED_DEVICE_REFERENCE_CAPABILITIES_SET.has(capability)) {
      return {
        ok: false,
        code: 'invalid_capabilities',
        message: 'capabilities contains an unsupported value',
        details: [
          {
            field: 'capabilities',
            value: capabilityRaw,
            allowed: ALLOWED_DEVICE_REFERENCE_CAPABILITIES
          }
        ]
      };
    }
    if (!seen.has(capability)) {
      seen.add(capability);
      out.push(capability);
    }
  }
  return { ok: true, provided: true, value: out };
}

function normalizeMeta(metaRaw) {
  if (metaRaw === undefined || metaRaw === null) {
    return { ok: true, value: {} };
  }

  const parsed = parseObjectLike(metaRaw);
  if (!parsed || Array.isArray(parsed)) {
    return {
      ok: false,
      code: 'invalid_meta',
      message: 'meta must be a JSON object'
    };
  }

  return { ok: true, value: parsed };
}

function normalizeDeviceReferenceCreateInput(msg) {
  const payload = asPayloadObject(msg);
  if (!payload) {
    return setDeviceReferenceValidationError(msg, 'invalid_payload', 'payload must be an object');
  }

  const networkResult = normalizeNetwork(payload.network);
  if (!networkResult.ok) {
    return setDeviceReferenceValidationError(msg, networkResult.code, networkResult.message);
  }
  const network = networkResult.value;

  const vendor = trimmedString(payload.vendor);
  const modelRaw = trimmedString(payload.model);
  const keyRaw = lowerTrimmedString(payload.reference_key || payload.referenceKey);
  const referenceDisplayName = trimmedString(payload.reference_display_name || payload.referenceDisplayName);
  const mappingFilePath = trimmedString(payload.mapping_file_path || payload.mappingFilePath);

  if (!referenceDisplayName) {
    return setDeviceReferenceValidationError(
      msg,
      'missing_reference_display_name',
      'reference_display_name is required'
    );
  }

  let model = modelRaw;
  let referenceKey = keyRaw;

  if (network === 'zigbee') {
    if (!vendor && !modelRaw) {
      return setDeviceReferenceValidationError(
        msg,
        'missing_vendor_model',
        'zigbee reference requires vendor and model',
        [
          { field: 'vendor', required: true },
          { field: 'model', required: true }
        ]
      );
    }
    if (!vendor) {
      return setDeviceReferenceValidationError(
        msg,
        'missing_vendor',
        'zigbee reference requires vendor',
        [{ field: 'vendor', required: true }]
      );
    }
    if (!modelRaw) {
      return setDeviceReferenceValidationError(
        msg,
        'missing_model',
        'zigbee reference requires model',
        [{ field: 'model', required: true }]
      );
    }

    referenceKey = `${vendor.toLowerCase()}_${modelRaw.toLowerCase()}`;
    if (keyRaw && keyRaw !== referenceKey) {
      return setDeviceReferenceValidationError(
        msg,
        'reference_key_mismatch',
        'for zigbee, reference_key must equal lower(vendor) + "_" + lower(model)',
        [
          { field: 'reference_key', provided: keyRaw, expected: referenceKey }
        ]
      );
    }
  } else if (network === 'lorawan') {
    const loraKeySource = keyRaw || lowerTrimmedString(modelRaw);
    if (!loraKeySource) {
      return setDeviceReferenceValidationError(
        msg,
        'missing_reference_key',
        'lorawan reference requires reference_key or model'
      );
    }

    referenceKey = loraKeySource;
    if (!model) {
      model = referenceKey;
    }
  }

  if (!referenceKey) {
    return setDeviceReferenceValidationError(msg, 'missing_reference_key', 'reference_key could not be derived');
  }

  if (!model) {
    return setDeviceReferenceValidationError(msg, 'missing_model', 'model is required');
  }

  const metaResult = normalizeMeta(payload.meta);
  if (!metaResult.ok) {
    return setDeviceReferenceValidationError(msg, metaResult.code, metaResult.message);
  }

  const capabilitiesResult = normalizeCapabilities(payload.capabilities);
  if (!capabilitiesResult.ok) {
    return setDeviceReferenceValidationError(
      msg,
      capabilitiesResult.code,
      capabilitiesResult.message,
      capabilitiesResult.details
    );
  }

  const meta = {
    ...metaResult.value,
    reference_display_name: referenceDisplayName
  };

  const slug = lowerTrimmedString(payload.reference_display_name_slug || payload.referenceDisplayNameSlug);
  if (slug) {
    meta.reference_display_name_slug = slug;
  }

  const input = {
    network,
    reference_key: referenceKey,
    vendor: vendor || null,
    model,
    reference_display_name: referenceDisplayName,
    mapping_file_path: mappingFilePath || null,
    meta
  };

  if (capabilitiesResult.provided) {
    input.capabilities = capabilitiesResult.value;
  }

  return setDeviceReferenceValidationOk(msg, 'create', input);
}

function normalizeDeviceReferenceUpdateInput(msg) {
  const payload = asPayloadObject(msg);
  if (!payload) {
    return setDeviceReferenceValidationError(msg, 'invalid_payload', 'payload must be an object');
  }

  const id = parsePositiveInt(payload.id);
  if (!id) {
    return setDeviceReferenceValidationError(msg, 'invalid_id', 'id must be a positive integer');
  }

  const referenceDisplayName = trimmedString(payload.reference_display_name || payload.referenceDisplayName);
  if (!referenceDisplayName) {
    return setDeviceReferenceValidationError(
      msg,
      'missing_reference_display_name',
      'reference_display_name is required'
    );
  }

  const vendor = trimmedString(payload.vendor);
  const model = trimmedString(payload.model);
  const mappingFilePath = trimmedString(payload.mapping_file_path || payload.mappingFilePath);

  const metaResult = normalizeMeta(payload.meta);
  if (!metaResult.ok) {
    return setDeviceReferenceValidationError(msg, metaResult.code, metaResult.message);
  }

  const capabilitiesResult = normalizeCapabilities(payload.capabilities);
  if (!capabilitiesResult.ok) {
    return setDeviceReferenceValidationError(
      msg,
      capabilitiesResult.code,
      capabilitiesResult.message,
      capabilitiesResult.details
    );
  }

  const meta = {
    ...metaResult.value,
    reference_display_name: referenceDisplayName
  };

  const slug = lowerTrimmedString(payload.reference_display_name_slug || payload.referenceDisplayNameSlug);
  if (slug) {
    meta.reference_display_name_slug = slug;
  }

  const input = {
    id,
    vendor: vendor || null,
    model: model || null,
    reference_display_name: referenceDisplayName,
    mapping_file_path: mappingFilePath || null,
    meta
  };

  if (capabilitiesResult.provided) {
    input.capabilities = capabilitiesResult.value;
  }

  return setDeviceReferenceValidationOk(msg, 'update', input);
}

function parseCapabilitiesColumn(value) {
  if (Array.isArray(value)) {
    return value.map((v) => trimmedString(v)).filter(Boolean);
  }

  if (typeof value === 'string') {
    const s = value.trim();
    if (s.startsWith('{') && s.endsWith('}')) {
      const body = s.slice(1, -1);
      if (body.length === 0) {
        return [];
      }
      return body.split(',').map((token) => token.trim()).filter(Boolean);
    }
  }

  return [];
}

function formatDeviceReferences(msg) {
  const rows = Array.isArray(msg.payload) ? msg.payload : [];

  msg.payload = rows.map((row) => {
    const meta = parseObjectLike(row.meta) || {};
    const displayName = row.reference_display_name
      || meta.reference_display_name
      || row.reference_key
      || null;

    return {
      id: row.id,
      network: row.network,
      referenceKey: row.reference_key || null,
      vendor: row.vendor || null,
      model: row.model || null,
      activeMappingVersion: row.active_mapping_version || null,
      mappingFilePath: row.mapping_file_path || null,
      referenceDisplayName: displayName,
      capabilities: parseCapabilitiesColumn(row.capabilities),
      meta,
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null
    };
  });

  return msg;
}

function parseDeviceReferenceSuggestionFilters(msg) {
  const query = (msg && msg.req && msg.req.query && typeof msg.req.query === 'object') ? msg.req.query : {};
  const payload = {};

  const network = lowerTrimmedString(query.network);
  if (network === 'zigbee' || network === 'lorawan') {
    payload.network = network;
  }

  if (query.only_unlinked !== undefined) {
    payload.only_unlinked = isTrue(query.only_unlinked);
  }

  msg.payload = payload;
  return msg;
}

function parseDeviceReferenceListFilters(msg) {
  const query = (msg && msg.req && msg.req.query && typeof msg.req.query === 'object') ? msg.req.query : {};
  const payload = {};

  const network = lowerTrimmedString(query.network);
  if (network === 'zigbee' || network === 'lorawan') {
    payload.network = network;
  }

  msg.payload = payload;
  return msg;
}

function normalizeMappingDataType(rawType, fallbackType) {
  const direct = lowerTrimmedString(rawType);
  if (direct && ALLOWED_DEVICE_REFERENCE_MAPPING_DATA_TYPES_SET.has(direct)) {
    return direct;
  }

  const fallback = lowerTrimmedString(fallbackType);
  if (!fallback) {
    return 'text';
  }

  if (fallback === 'number' || fallback === 'integer' || fallback === 'boolean' || fallback === 'timestamp') {
    return fallback;
  }

  if (fallback === 'object' || fallback === 'array' || fallback === 'json' || fallback === 'null') {
    return 'json';
  }

  return 'text';
}

function normalizeApiDeviceReferenceMappingFieldsRequest(msg) {
  const reqParams = (msg && msg.req && msg.req.params && typeof msg.req.params === 'object') ? msg.req.params : {};
  const payload = asPayloadObject(msg);
  const id = parsePositiveInt((payload && payload.id !== undefined) ? payload.id : reqParams.id);

  if (!id) {
    return setDeviceReferenceMappingValidationError(msg, 'invalid_id', 'id must be a positive integer');
  }

  return setDeviceReferenceMappingValidationOk(msg, { id });
}

function normalizeApiDeviceReferenceMappingsReplaceRequest(msg) {
  const payload = asPayloadObject(msg);
  if (!payload) {
    return setDeviceReferenceMappingValidationError(msg, 'invalid_payload', 'payload must be an object');
  }

  const reqParams = (msg && msg.req && msg.req.params && typeof msg.req.params === 'object') ? msg.req.params : {};
  const id = parsePositiveInt(payload.id !== undefined ? payload.id : reqParams.id);
  if (!id) {
    return setDeviceReferenceMappingValidationError(msg, 'invalid_id', 'id must be a positive integer');
  }

  const mappingsRaw = payload.mappings;
  if (!Array.isArray(mappingsRaw)) {
    return setDeviceReferenceMappingValidationError(
      msg,
      'invalid_mappings',
      'mappings must be an array'
    );
  }

  const out = [];
  const seenSourcePath = new Set();
  const seenNormalizedField = new Set();

  for (let i = 0; i < mappingsRaw.length; i++) {
    const row = mappingsRaw[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return setDeviceReferenceMappingValidationError(
        msg,
        'invalid_mappings',
        'each mapping must be an object',
        [{ index: i }]
      );
    }

    const sourcePath = trimmedString(row.source_path || row.sourcePath);
    if (!sourcePath) {
      return setDeviceReferenceMappingValidationError(
        msg,
        'invalid_mappings',
        'source_path is required for each mapping',
        [{ index: i, field: 'source_path' }]
      );
    }

    if (seenSourcePath.has(sourcePath)) {
      return setDeviceReferenceMappingValidationError(
        msg,
        'duplicate_source_path',
        'source_path must be unique in mappings payload',
        [{ index: i, field: 'source_path', value: sourcePath }]
      );
    }
    seenSourcePath.add(sourcePath);

    const role = lowerTrimmedString(row.role);
    if (!role || role === 'ignore') {
      continue;
    }
    if (!ALLOWED_DEVICE_REFERENCE_MAPPING_ROLES_SET.has(role)) {
      return setDeviceReferenceMappingValidationError(
        msg,
        'invalid_mapping_role',
        'role is not supported',
        [{ index: i, field: 'role', value: row.role, allowed: ALLOWED_DEVICE_REFERENCE_MAPPING_ROLES }]
      );
    }

    const normalizedField = lowerTrimmedString(row.normalized_field || row.normalizedField)
      || defaultNormalizedFieldFromSourcePath(sourcePath);
    if (!normalizedField) {
      return setDeviceReferenceMappingValidationError(
        msg,
        'invalid_normalized_field',
        'normalized_field could not be derived',
        [{ index: i, field: 'normalized_field' }]
      );
    }

    if (seenNormalizedField.has(normalizedField)) {
      return setDeviceReferenceMappingValidationError(
        msg,
        'duplicate_normalized_field',
        'normalized_field must be unique in mappings payload',
        [{ index: i, field: 'normalized_field', value: normalizedField }]
      );
    }
    seenNormalizedField.add(normalizedField);

    const dataType = normalizeMappingDataType(
      row.data_type || row.dataType,
      row.inferred_data_type || row.inferredDataType
    );
    if (!ALLOWED_DEVICE_REFERENCE_MAPPING_DATA_TYPES_SET.has(dataType)) {
      return setDeviceReferenceMappingValidationError(
        msg,
        'invalid_mapping_data_type',
        'data_type is not supported',
        [{ index: i, field: 'data_type', value: row.data_type || row.dataType, allowed: ALLOWED_DEVICE_REFERENCE_MAPPING_DATA_TYPES }]
      );
    }

    const unit = trimmedString(row.unit) || null;
    const transformHint = trimmedString(row.transform_hint || row.transformHint) || null;
    const parsedMeta = normalizeMeta(row.meta);
    if (!parsedMeta.ok) {
      return setDeviceReferenceMappingValidationError(
        msg,
        parsedMeta.code,
        parsedMeta.message,
        [{ index: i, field: 'meta' }]
      );
    }

    const boolValue = parseBoolean(row.is_active !== undefined ? row.is_active : row.isActive);
    const isActive = boolValue === null ? true : boolValue;

    out.push({
      source_path: sourcePath,
      normalized_field: normalizedField,
      role,
      data_type: dataType,
      unit,
      is_active: isActive,
      transform_hint: transformHint,
      meta: parsedMeta.value
    });
  }

  return setDeviceReferenceMappingValidationOk(msg, {
    id,
    mappings: out
  });
}

function formatDeviceReferenceMappingFields(msg) {
  const rows = Array.isArray(msg.payload) ? msg.payload : [];
  if (rows.length === 0) {
    msg.payload = null;
    return msg;
  }

  const first = rows[0];
  const out = {
    referenceId: first.reference_id,
    network: first.network || null,
    referenceKey: first.reference_key || null,
    activeMappingVersion: first.active_mapping_version || null,
    fields: []
  };

  for (const row of rows) {
    const sourcePath = row.source_path || null;
    if (!sourcePath) {
      continue;
    }

    let sampleValue = row.sample_value;
    if (typeof sampleValue === 'string') {
      try {
        sampleValue = JSON.parse(sampleValue);
      } catch (err) {
        sampleValue = row.sample_value;
      }
    }

    const inferredType = lowerTrimmedString(row.inferred_data_type);
    const dataType = lowerTrimmedString(row.data_type) || normalizeMappingDataType(null, inferredType);
    const role = lowerTrimmedString(row.role);
    const normalizedField = lowerTrimmedString(row.normalized_field) || defaultNormalizedFieldFromSourcePath(sourcePath);

    out.fields.push({
      sourcePath,
      inferredDataType: inferredType || null,
      sampleValue: sampleValue === undefined ? null : sampleValue,
      seenCount: row.seen_count !== null && row.seen_count !== undefined ? Number(row.seen_count) : null,
      lastSeenAt: row.last_seen_at || null,
      mapped: row.mapping_id !== null && row.mapping_id !== undefined,
      mappingId: row.mapping_id || null,
      normalizedField,
      role: role || 'ignore',
      dataType,
      unit: row.unit || null,
      isActive: row.is_active === null || row.is_active === undefined ? true : isTrue(row.is_active)
    });
  }

  out.fields.sort((a, b) => String(a.sourcePath || '').localeCompare(String(b.sourcePath || '')));
  msg.payload = out;
  return msg;
}

function formatDeviceReferenceMappingsReplace(msg) {
  const rows = Array.isArray(msg.payload) ? msg.payload : [];
  if (rows.length === 0) {
    msg.payload = null;
    return msg;
  }

  const first = rows[0];
  let mappings = first.mappings;
  if (typeof mappings === 'string') {
    try {
      mappings = JSON.parse(mappings);
    } catch (err) {
      mappings = [];
    }
  }
  if (!Array.isArray(mappings)) {
    mappings = [];
  }

  msg.payload = {
    referenceId: first.reference_id,
    mappings: mappings.map((row) => ({
      id: row.id,
      sourcePath: row.source_path || null,
      normalizedField: row.normalized_field || null,
      role: row.role || null,
      dataType: row.data_type || null,
      unit: row.unit || null,
      isActive: row.is_active !== false
    }))
  };
  return msg;
}

function normalizeApiDeviceReferenceCreateRequest(msg) {
  return normalizeDeviceReferenceCreateInput(msg);
}

function normalizeApiDeviceReferenceUpdateRequest(msg) {
  const requestPayload = asPayloadObject(msg) ? { ...msg.payload } : {};
  const reqParams = (msg && msg.req && msg.req.params && typeof msg.req.params === 'object') ? msg.req.params : {};

  if (requestPayload.id === undefined && reqParams.id !== undefined) {
    requestPayload.id = reqParams.id;
  }

  msg.payload = requestPayload;
  return normalizeDeviceReferenceUpdateInput(msg);
}

function normalizeDeviceReferenceLinkInput(msg) {
  const payload = asPayloadObject(msg);
  if (!payload) {
    msg.deviceReferenceLinkInput = null;
    msg.deviceReferenceLinkValidation = {
      ok: false,
      statusCode: 422,
      code: 'invalid_payload',
      message: 'payload must be an object'
    };
    return msg;
  }

  const deviceId = parsePositiveInt(payload.device_id || payload.deviceId);
  const referenceId = parsePositiveInt(payload.reference_id || payload.referenceId);

  if (!deviceId || !referenceId) {
    msg.deviceReferenceLinkInput = null;
    msg.deviceReferenceLinkValidation = {
      ok: false,
      statusCode: 422,
      code: 'invalid_link_input',
      message: 'device_id and reference_id must be positive integers'
    };
    return msg;
  }

  msg.deviceReferenceLinkInput = {
    device_id: deviceId,
    reference_id: referenceId
  };
  msg.deviceReferenceLinkValidation = {
    ok: true,
    statusCode: 200
  };
  return msg;
}

function formatSingleDeviceReference(msg) {
  const row = Array.isArray(msg.payload) ? msg.payload[0] : null;
  const tmp = { payload: row ? [row] : [] };
  formatDeviceReferences(tmp);
  msg.payload = tmp.payload.length > 0 ? tmp.payload[0] : null;
  return msg;
}

function wrapApiData(msg, statusCode) {
  msg.statusCode = Number.isInteger(statusCode) ? statusCode : 200;
  msg.payload = {
    ok: true,
    data: msg.payload
  };
  return msg;
}

function setApiError(msg, statusCode, code, message, details) {
  msg.statusCode = Number.isInteger(statusCode) ? statusCode : 400;
  msg.payload = {
    ok: false,
    error: {
      code: code || 'bad_request',
      message: message || 'request failed',
      details: Array.isArray(details) ? details : []
    }
  };
  return msg;
}

function tokenizePath(sourcePath) {
  if (typeof sourcePath !== 'string' || sourcePath.trim().length === 0) {
    return [];
  }

  const tokens = [];
  const segments = sourcePath.split('.');
  for (const segment of segments) {
    if (!segment) {
      continue;
    }
    const re = /([^[\]]+)|\[(\d+)\]/g;
    let match;
    while ((match = re.exec(segment)) !== null) {
      if (match[1] !== undefined) {
        tokens.push(match[1]);
      } else if (match[2] !== undefined) {
        tokens.push(Number(match[2]));
      }
    }
  }
  return tokens;
}

function getByPath(root, sourcePath) {
  const tokens = tokenizePath(sourcePath);
  let current = root;
  for (const token of tokens) {
    if (typeof token === 'number') {
      if (!Array.isArray(current) || token < 0 || token >= current.length) {
        return undefined;
      }
      current = current[token];
      continue;
    }

    if (!current || typeof current !== 'object' || !(token in current)) {
      return undefined;
    }
    current = current[token];
  }
  return current;
}

function parseBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'off'].includes(s)) return false;
  }
  return null;
}

function coerceForMetric(rawValue, dataType) {
  if (rawValue === undefined || rawValue === null) {
    return null;
  }

  const t = String(dataType || '').toLowerCase();

  if (t === 'number' || t === 'integer') {
    const n = Number(rawValue);
    if (!Number.isFinite(n)) {
      return null;
    }
    return {
      value_type: 'number',
      value_number: t === 'integer' ? Math.trunc(n) : n
    };
  }

  if (t === 'boolean') {
    const b = parseBoolean(rawValue);
    if (b === null) {
      return null;
    }
    return {
      value_type: 'boolean',
      value_boolean: b
    };
  }

  if (t === 'json') {
    return {
      value_type: 'json',
      value_json: rawValue
    };
  }

  if (t === 'timestamp') {
    const ms = Date.parse(String(rawValue));
    if (Number.isNaN(ms)) {
      return null;
    }
    return {
      value_type: 'text',
      value_text: new Date(ms).toISOString()
    };
  }

  if (typeof rawValue === 'object') {
    return {
      value_type: 'text',
      value_text: JSON.stringify(rawValue)
    };
  }

  return {
    value_type: 'text',
    value_text: String(rawValue)
  };
}

function asObject(value) {
  if (value && typeof value === 'object') {
    return value;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch (err) {
      return null;
    }
  }
  return null;
}

function applyMappings(msg) {
  const telemetry = msg.telemetryInserted || {};
  const mappingRows = Array.isArray(msg.payload) ? msg.payload : [];

  if (!telemetry || !telemetry.telemetry_id || !telemetry.device_id || mappingRows.length === 0) {
    return null;
  }

  const src = asObject(telemetry.metrics) || asObject(msg?.poc?.metrics);
  if (!src) {
    return null;
  }

  const out = [];
  for (const mapping of mappingRows) {
    const metricName = mapping && mapping.normalized_field;
    const sourcePath = mapping && mapping.source_path;
    if (typeof metricName !== 'string' || metricName.length === 0 || typeof sourcePath !== 'string' || sourcePath.length === 0) {
      continue;
    }

    const rawValue = getByPath(src, sourcePath);
    if (rawValue === undefined) {
      continue;
    }

    const coerced = coerceForMetric(rawValue, mapping.data_type);
    if (!coerced) {
      continue;
    }

    out.push({
      metric_name: metricName,
      source_path: sourcePath,
      mapping_id: mapping.mapping_id || null,
      unit: mapping.unit || null,
      value_type: coerced.value_type,
      value_number: coerced.value_number !== undefined ? coerced.value_number : null,
      value_text: coerced.value_text !== undefined ? coerced.value_text : null,
      value_boolean: coerced.value_boolean !== undefined ? coerced.value_boolean : null,
      value_json: coerced.value_json !== undefined ? coerced.value_json : null
    });
  }

  if (out.length === 0) {
    return null;
  }

  msg.metricRows = out;
  return msg;
}

function thresholdMsFromEnv(envApi) {
  const thresholdMinRaw = envApi && typeof envApi.get === 'function'
    ? (envApi.get('THRESHOLD_LAST_SEEN_MINUTES') || 60)
    : 60;
  const thresholdMin = Number(thresholdMinRaw);
  return Number.isFinite(thresholdMin) ? thresholdMin * 60 * 1000 : 60 * 60 * 1000;
}

function availabilityFromMetricsForStatus(metricsRaw) {
  const metrics = asObject(metricsRaw) || {};
  const direct = normalizeAvailabilityValue(metrics.availability);
  if (direct) {
    return direct;
  }
  // Backward compatibility for older ingested availability payloads.
  return normalizeAvailabilityValue(metrics.raw);
}

function computeOnlineStatus(lastTs, thresholdMs, metricsRaw) {
  const availability = availabilityFromMetricsForStatus(metricsRaw);
  if (availability === 'offline') {
    return false;
  }
  const lastMs = lastTs ? Date.parse(lastTs) : NaN;
  return Number.isFinite(lastMs) && (Date.now() - lastMs) <= thresholdMs;
}

function batteryColor(pct) {
  if (pct === null || pct === undefined || Number.isNaN(Number(pct))) return '#9e9e9e';
  const n = Number(pct);
  if (n <= 100 && n > 75) return '#2e7d32';
  if (n <= 75 && n > 50) return '#7cb342';
  if (n <= 50 && n > 25) return '#ef6c00';
  if (n <= 25 && n >= 0) return '#c62828';
  return '#9e9e9e';
}

function pctFromVoltageSafe(v, profile, pctFromVoltage) {
  if (!profile || typeof pctFromVoltage !== 'function') {
    return null;
  }
  const computed = pctFromVoltage(Number(v), profile.min, profile.max);
  return Number.isFinite(computed) ? computed : null;
}

function buildActivityChartPoints(msg) {
  const rows = Array.isArray(msg.payload) ? msg.payload : [];
  const points = rows.map((row) => {
    const x = new Date(row.bucket).getTime();
    return { x, y: Number(row.events || 0) };
  });

  msg.topic = 'events_per_min';
  msg.payload = points;
  msg.action = 'replace';
  return msg;
}

function updateActivityHistogram(msg, flow) {
  const now = Date.now();
  const bucketMs = 60 * 1000;
  const bucket = Math.floor(now / bucketMs) * bucketMs;

  const state = flow.get('hist_state') || { bucket: null, count: 0 };

  if (state.bucket === null) {
    state.bucket = bucket;
  }

  if (bucket === state.bucket) {
    state.count += 1;
    flow.set('hist_state', state);
    return null;
  }

  msg.topic = 'events_per_min';
  msg.payload = state.count;
  msg.timestamp = state.bucket;

  state.bucket = bucket;
  state.count = 1;
  flow.set('hist_state', state);

  return msg;
}

function setActivitySource(msg, flow) {
  const source = msg.payload;
  if (source) {
    flow.set('activity_source', source);
  }
  return msg;
}

function setActivityRange(msg, flow) {
  const range = msg.payload;
  if (range) {
    flow.set('activity_range', range);
  }
  return msg;
}

function setPeriodicRange(msg, flow) {
  const allowedRanges = new Set(['1h', '6h', '24h', '7d']);
  const selectedRange = String(msg && msg.payload ? msg.payload : '').trim();
  flow.set('periodic_range', allowedRanges.has(selectedRange) ? selectedRange : '1h');
  return { payload: 'refresh' };
}

function setPeriodicBucket(msg, flow) {
  const allowedBuckets = new Set(['auto', '1 minute', '5 minutes', '15 minutes', '1 hour']);
  const selectedBucket = String(msg && msg.payload ? msg.payload : '').trim();
  flow.set('periodic_bucket', allowedBuckets.has(selectedBucket) ? selectedBucket : 'auto');
  return { payload: 'refresh' };
}

function triggerPeriodicQueries() {
  return { view: 'metrics' };
}

function formatAllDevices(msg, deps) {
  const rows = Array.isArray(msg.payload) ? msg.payload : [];
  const thresholdMs = thresholdMsFromEnv(deps && deps.env);

  msg.payload = rows.map((r) => {
    const lastTs = r.last_ts || r.last_seen_at || null;
    const online = computeOnlineStatus(lastTs, thresholdMs, r.metrics);

    return {
      deviceId: r.device_id,
      externalId: r.external_id,
      device: r.display_name || r.external_id,
      network: r.network || 'n/a',
      lastTs,
      online,
      currentReferenceId: r.device_reference_id || null,
      currentReferenceKey: r.reference_key || null,
      currentReferenceDisplayName: r.reference_display_name || null
    };
  });
  return msg;
}

function metricValue(obj, key) {
  return (obj && obj[key] !== undefined && obj[key] !== null) ? obj[key] : undefined;
}

function deriveMappedBattery(row) {
  const valueType = lowerTrimmedString(row && row.mapped_battery_value_type);
  const unit = lowerTrimmedString(row && row.mapped_battery_unit) || '';

  let numericValue = null;
  if (valueType === 'number' || valueType === 'integer') {
    const n = Number(row.mapped_battery_value_number);
    numericValue = Number.isFinite(n) ? n : null;
  } else if (valueType === 'text') {
    const n = Number(String(row.mapped_battery_value_text || '').trim());
    numericValue = Number.isFinite(n) ? n : null;
  }

  if (!Number.isFinite(numericValue)) {
    return {
      batteryPct: null,
      batteryV: null
    };
  }

  if (
    unit === '%'
    || unit === 'pct'
    || unit === 'percent'
    || unit === 'percentage'
    || unit.includes('percent')
  ) {
    return {
      batteryPct: numericValue,
      batteryV: null
    };
  }

  if (unit === 'mv' || unit === 'millivolt' || unit === 'millivolts') {
    return {
      batteryPct: null,
      batteryV: numericValue / 1000
    };
  }

  if (unit === 'v' || unit === 'volt' || unit === 'volts') {
    return {
      batteryPct: null,
      batteryV: numericValue
    };
  }

  // Heuristics when unit is not provided by mapping.
  if (numericValue >= 0 && numericValue <= 100) {
    return {
      batteryPct: numericValue,
      batteryV: null
    };
  }

  if (numericValue >= 1.5 && numericValue <= 6) {
    return {
      batteryPct: null,
      batteryV: numericValue
    };
  }

  return {
    batteryPct: null,
    batteryV: null
  };
}

function deriveBatteryState(baseMetrics, batteryMetrics, pctFromVoltage) {
  const base = baseMetrics && typeof baseMetrics === 'object' ? baseMetrics : {};
  const battery = batteryMetrics && typeof batteryMetrics === 'object' ? batteryMetrics : {};

  const batteryPctVal = metricValue(base, 'battery') ?? metricValue(base, 'battery_percentage')
    ?? metricValue(battery, 'battery') ?? metricValue(battery, 'battery_percentage');
  const batteryPctRaw = batteryPctVal !== undefined ? Number(batteryPctVal) : null;

  const batteryVRaw = metricValue(base, 'battery_v')
    ?? (base.object && metricValue(base.object, 'battery_v'))
    ?? metricValue(battery, 'battery_v')
    ?? (battery.object && metricValue(battery.object, 'battery_v'));

  const hasPct = Number.isFinite(batteryPctRaw);
  const hasV = batteryVRaw !== undefined && batteryVRaw !== null && Number.isFinite(Number(batteryVRaw));

  const powerSource = String(base.power_source || battery.power_source || '').trim().toLowerCase();
  const powerFlags = [
    base.mains,
    base.mains_powered,
    battery.mains,
    battery.mains_powered
  ];
  const isMains = ['mains', 'main', 'ac', 'line'].includes(powerSource)
    || powerFlags.some((v) => parseBoolean(v) === true);

  let batteryPct = hasPct ? batteryPctRaw : null;
  if (!hasPct && hasV) {
    batteryPct = pctFromVoltageSafe(Number(batteryVRaw), { min: 2.1, max: 3.0 }, pctFromVoltage);
  }
  if (Number.isFinite(batteryPct)) {
    batteryPct = Math.max(0, Math.min(100, Math.round(batteryPct)));
  }

  const isBatteryPct = Number.isFinite(batteryPct);
  const batteryText = isMains
    ? 'Connected device'
    : (isBatteryPct
      ? `${batteryPct}%`
      : (hasV ? `${Number(batteryVRaw).toFixed(2)} V` : 'n/a'));

  return {
    isMains,
    isBatteryPct,
    batteryPct: isBatteryPct ? batteryPct : null,
    batteryText,
    batteryColor: isMains ? '#2e7d32' : (isBatteryPct ? batteryColor(batteryPct) : '#9e9e9e')
  };
}

function parseMappings(raw) {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  }
  return [];
}

function formatActuationState(raw) {
  if (raw === undefined || raw === null) {
    return 'n/a';
  }
  const asBool = parseBoolean(raw);
  if (asBool === true) {
    return 'ON';
  }
  if (asBool === false) {
    return 'OFF';
  }
  if (typeof raw === 'object') {
    try {
      return JSON.stringify(raw);
    } catch (err) {
      return String(raw);
    }
  }
  return String(raw);
}

function formatActuatorStatus(msg, deps) {
  const rows = Array.isArray(msg.payload) ? msg.payload : [];
  const thresholdMs = thresholdMsFromEnv(deps && deps.env);
  const pctFromVoltage = deps && deps.batteryHelpers && deps.batteryHelpers.pctFromVoltage;

  const items = rows.map((r) => {
    const id = r && r.external_id ? String(r.external_id) : null;
    if (!id) {
      return null;
    }

    const label = (r && r.display_name) ? String(r.display_name) : id;
    const network = r && r.network ? String(r.network) : null;
    const lastTs = r && r.ts ? r.ts : null;
    const online = computeOnlineStatus(lastTs, thresholdMs, r.metrics);
    const hasActuation = isTrue(r && r.has_actuation);
    const toggleCapableNetwork = network === 'zigbee' || network === 'lorawan';
    const metrics = asObject(r && r.metrics) || {};
    const mappings = parseMappings(r && r.mappings);

    const actuationMapping = mappings.find((m) => String(m && m.role || '').toLowerCase() === 'actuation')
      || mappings.find((m) => String(m && m.role || '').toLowerCase() === 'status')
      || null;
    const sourcePath = actuationMapping && typeof actuationMapping.source_path === 'string'
      ? actuationMapping.source_path
      : (metrics.state !== undefined ? 'state' : (metrics.relay !== undefined ? 'relay' : null));
    const stateValue = sourcePath ? getByPath(metrics, sourcePath) : undefined;
    const stateText = formatActuationState(stateValue);

    const batteryInfo = deriveBatteryState(metrics, null, pctFromVoltage);
    const referenceDisplayName = cleanString(r && r.reference_display_name);
    const referenceKey = cleanString(r && r.reference_key);
    const referenceLabel = referenceDisplayName && referenceKey && referenceDisplayName !== referenceKey
      ? `${referenceDisplayName} (${referenceKey})`
      : (referenceDisplayName || referenceKey || 'Unlinked reference');

    return {
      id,
      externalId: id,
      label,
      network: network || 'n/a',
      referenceDisplayName: referenceDisplayName || null,
      referenceKey: referenceKey || null,
      referenceLabel,
      lastTs,
      online,
      unavailable: !lastTs,
      canToggle: hasActuation && toggleCapableNetwork,
      stateText,
      batteryText: lastTs ? batteryInfo.batteryText : 'n/a',
      batteryColor: lastTs ? batteryInfo.batteryColor : '#9e9e9e'
    };
  }).filter(Boolean);

  items.sort((a, b) => {
    const refCmp = String(a.referenceLabel || '').localeCompare(String(b.referenceLabel || ''));
    if (refCmp !== 0) return refCmp;
    return String(a.label || '').localeCompare(String(b.label || ''));
  });

  msg.payload = items;
  return msg;
}

function buildToggleCommand(msg) {
  const row = Array.isArray(msg.payload) ? msg.payload[0] : null;
  if (!row) {
    return null;
  }

  const metrics = asObject(row.metrics) || {};
  let mappings = row.mappings;
  if (typeof mappings === 'string') {
    try {
      mappings = JSON.parse(mappings);
    } catch (err) {
      mappings = [];
    }
  }
  if (!Array.isArray(mappings)) {
    mappings = [];
  }

  const actuation = mappings.find((m) => String(m && m.role || '').toLowerCase() === 'actuation')
    || mappings.find((m) => String(m && m.role || '').toLowerCase() === 'status')
    || null;

  const sourcePath = actuation && typeof actuation.source_path === 'string' && actuation.source_path.length > 0
    ? actuation.source_path
    : 'state';
  const dataType = actuation && actuation.data_type ? String(actuation.data_type).toLowerCase() : 'text';
  const rawCurrent = getByPath(metrics, sourcePath);

  let commandValue;
  if (dataType === 'boolean') {
    const b = parseBoolean(rawCurrent);
    commandValue = b === null ? true : !b;
  } else if (dataType === 'number' || dataType === 'integer') {
    const n = Number(rawCurrent);
    commandValue = Number.isFinite(n) && n !== 0 ? 0 : 1;
  } else {
    const maybeBool = parseBoolean(rawCurrent);
    if (maybeBool !== null) {
      commandValue = !maybeBool;
    } else {
      const t = String(rawCurrent == null ? '' : rawCurrent).trim().toUpperCase();
      commandValue = t === 'ON' ? 'OFF' : 'ON';
    }
  }

  const sourceTokens = tokenizePath(sourcePath);
  let commandKey = 'state';
  for (let i = sourceTokens.length - 1; i >= 0; i--) {
    if (typeof sourceTokens[i] === 'string' && sourceTokens[i].length > 0) {
      commandKey = sourceTokens[i];
      break;
    }
  }

  if (row.network === 'zigbee') {
    const lastTopic = row && row.meta ? row.meta.last_topic : null;
    let topicBase = '';
    if (typeof lastTopic === 'string' && lastTopic.startsWith('zigbee2mqtt/')) {
      const parts = lastTopic.split('/');
      if (parts.length >= 2) {
        topicBase = 'zigbee2mqtt/' + parts[1];
      }
    }
    if (!topicBase && row.display_name) {
      topicBase = 'zigbee2mqtt/' + row.display_name;
    }
    if (!topicBase && row.external_id) {
      topicBase = 'zigbee2mqtt/' + row.external_id;
    }
    if (!topicBase) {
      return null;
    }

    let zigbeeValue = commandValue;
    if (commandKey === 'state') {
      const boolValue = parseBoolean(commandValue);
      if (boolValue !== null) {
        zigbeeValue = boolValue ? 'ON' : 'OFF';
      } else if (typeof zigbeeValue === 'string') {
        zigbeeValue = zigbeeValue.toUpperCase() === 'OFF' ? 'OFF' : 'ON';
      }
    }

    msg.topic = topicBase + '/set';
    msg.payload = { [commandKey]: zigbeeValue };
  } else if (row.network === 'lorawan') {
    const relayLike = commandKey === 'relay' || commandKey === 'state';
    if (!relayLike) {
      return null;
    }
    const asBool = parseBoolean(commandValue);
    const nextOn = asBool !== null ? asBool : Number(commandValue) === 1;
    const devEui = String(row.external_id || '').toLowerCase();
    msg.topic = 'application/1/device/' + devEui + '/command/down';
    msg.payload = { fPort: 85, confirmed: true, data: nextOn ? 'AQ==' : 'AA==' };
  } else {
    return null;
  }

  return msg;
}

function formatEventChanges(msg, deps) {
  const rows = Array.isArray(msg.payload) ? msg.payload : [];
  const thresholdMs = thresholdMsFromEnv(deps && deps.env);

  const byId = new Map();
  for (const row of rows) {
    const id = row.external_id;
    if (!id) {
      continue;
    }
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        label: row.display_name || null,
        lastTs: row.last_ts || null,
        lastMetrics: row.last_metrics || null,
        online: false,
        events: []
      });
    }
    const entry = byId.get(id);
    if (!entry.lastTs && row.last_ts) {
      entry.lastTs = row.last_ts;
    }
    if (!entry.lastMetrics && row.last_metrics) {
      entry.lastMetrics = row.last_metrics;
    }
    if (!entry.label && row.display_name) {
      entry.label = row.display_name;
    }
    if (row.metric_key) {
      entry.events.push({
        metricKey: row.metric_key,
        oldValue: row.old_value,
        newValue: row.new_value,
        ts: row.ts || null
      });
    }
  }

  const items = Array.from(byId.values()).map((entry) => {
    entry.online = computeOnlineStatus(entry.lastTs, thresholdMs, entry.lastMetrics);
    entry.label = entry.label || entry.id;
    entry.events.sort((a, b) => {
      const aTs = a && a.ts ? Date.parse(a.ts) : NaN;
      const bTs = b && b.ts ? Date.parse(b.ts) : NaN;
      const aNum = Number.isFinite(aTs) ? aTs : -Infinity;
      const bNum = Number.isFinite(bTs) ? bTs : -Infinity;
      return bNum - aNum;
    });
    return entry;
  });
  items.sort((a, b) => String(a.label || '').localeCompare(String(b.label || '')));

  msg.payload = items;
  return msg;
}

function formatPeriodicChartsByDevice(msg) {
  const rows = Array.isArray(msg.payload) ? msg.payload : [];
  const byDevice = new Map();
  let queryNowMs = NaN;
  let rangeStartMs = NaN;

  function normalizeMetricDataType(raw) {
    const t = String(raw || '').trim().toLowerCase();
    if (t === 'number' || t === 'integer' || t === 'boolean' || t === 'text') {
      return t;
    }
    return 'number';
  }

  function parseBooleanValue(raw) {
    if (raw === true || raw === false) {
      return raw;
    }
    const t = String(raw || '').trim().toLowerCase();
    if (t === 'true' || t === 't' || t === '1') {
      return true;
    }
    if (t === 'false' || t === 'f' || t === '0') {
      return false;
    }
    return null;
  }

  for (const r of rows) {
    const rowQueryNowMs = Date.parse(r && r.query_now ? r.query_now : '');
    if (Number.isFinite(rowQueryNowMs)) {
      queryNowMs = rowQueryNowMs;
    }
    const rowRangeStartMs = Date.parse(r && r.range_start ? r.range_start : '');
    if (Number.isFinite(rowRangeStartMs)) {
      rangeStartMs = rowRangeStartMs;
    }

    const deviceId = String(
      (r && r.device_external_id) || (r && r.device_label) || 'unknown-device'
    );
    const deviceLabel = String((r && r.device_label) || deviceId);
    const metricName = String((r && r.metric_name) || 'metric');
    const unit = (r && r.unit) ? String(r.unit) : null;
    const metricType = normalizeMetricDataType(r && r.metric_data_type);
    const metricKey = unit
      ? `${metricName}__${unit}__${metricType}`
      : `${metricName}__${metricType}`;

    if (!byDevice.has(deviceId)) {
      byDevice.set(deviceId, {
        deviceId,
        deviceLabel,
        metrics: new Map()
      });
    }

    const deviceEntry = byDevice.get(deviceId);
    if (!deviceEntry.metrics.has(metricKey)) {
      deviceEntry.metrics.set(metricKey, {
        metricName,
        unit,
        metricType,
        categories: [],
        _categoryIndexByValue: {},
        points: []
      });
    }

    const metricEntry = deviceEntry.metrics.get(metricKey);
    const bucketTs = Date.parse(r && r.bucket ? r.bucket : '');
    if (!Number.isFinite(bucketTs)) {
      continue;
    }

    if (metricType === 'boolean') {
      const b = parseBooleanValue(r && r.value_boolean);
      if (b === null) {
        continue;
      }
      metricEntry.points.push({
        x: bucketTs,
        y: b ? 1 : 0,
        label: b ? 'true' : 'false'
      });
      continue;
    }

    if (metricType === 'text') {
      const rawText = r && r.value_text;
      if (rawText === null || rawText === undefined) {
        continue;
      }
      const label = String(rawText);
      if (!Object.prototype.hasOwnProperty.call(metricEntry._categoryIndexByValue, label)) {
        metricEntry._categoryIndexByValue[label] = metricEntry.categories.length;
        metricEntry.categories.push(label);
      }
      metricEntry.points.push({
        x: bucketTs,
        y: metricEntry._categoryIndexByValue[label],
        label
      });
      continue;
    }

    const valueNum = Number(r && r.value_number);
    if (Number.isFinite(valueNum)) {
      metricEntry.points.push({
        x: bucketTs,
        y: valueNum,
        label: valueNum.toFixed(2)
      });
    }
  }

  const payload = Array.from(byDevice.values())
    .map((deviceEntry) => {
      const metrics = Array.from(deviceEntry.metrics.values())
        .map((metric) => {
          metric.points.sort((a, b) => a.x - b.x);

          if ((metric.metricType === 'boolean' || metric.metricType === 'text') && metric.points.length > 1) {
            const stepped = [metric.points[0]];
            for (let i = 0; i < metric.points.length - 1; i++) {
              const current = metric.points[i];
              const next = metric.points[i + 1];
              stepped.push({
                x: next.x,
                y: current.y,
                label: current.label
              });
              stepped.push(next);
            }
            metric.points = stepped;
          }

          delete metric._categoryIndexByValue;
          return metric;
        })
        .sort((a, b) => {
          const byName = String(a.metricName).localeCompare(String(b.metricName));
          if (byName !== 0) {
            return byName;
          }
          return String(a.metricType).localeCompare(String(b.metricType));
        });

      return {
        deviceId: deviceEntry.deviceId,
        deviceLabel: deviceEntry.deviceLabel,
        metrics
      };
    })
    .sort((a, b) => String(a.deviceLabel).localeCompare(String(b.deviceLabel)));

  const endMs = Number.isFinite(queryNowMs) ? queryNowMs : Date.now();
  const startMs = Number.isFinite(rangeStartMs) ? rangeStartMs : (endMs - (60 * 60 * 1000));
  msg.periodicWindowStartMs = startMs;
  msg.periodicWindowEndMs = endMs;
  msg.payload = payload;
  return msg;
}

function formatBatteryStatus(msg, deps) {
  const rows = Array.isArray(msg.payload) ? msg.payload : [];
  const thresholdMs = thresholdMsFromEnv(deps && deps.env);
  const pctFromVoltage = deps && deps.batteryHelpers && deps.batteryHelpers.pctFromVoltage;

  msg.payload = rows.map((r) => {
    const baseMetrics = r.metrics || {};
    const hasBatteryMapping = isTrue(r.has_battery_mapping);
    const mappedBattery = deriveMappedBattery(r);
    const referencePowerSource = lowerTrimmedString(r.reference_power_source);

    const batteryMetrics = {};
    if (Number.isFinite(mappedBattery.batteryPct)) {
      batteryMetrics.battery = mappedBattery.batteryPct;
    }
    if (Number.isFinite(mappedBattery.batteryV)) {
      batteryMetrics.battery_v = mappedBattery.batteryV;
    }

    if (!hasBatteryMapping || referencePowerSource === 'mains') {
      batteryMetrics.mains_powered = true;
    } else if (referencePowerSource === 'battery') {
      batteryMetrics.mains_powered = false;
    }

    // For battery-powered devices, use dynamic role=battery mappings as source of truth.
    const batteryBaseMetrics = hasBatteryMapping ? {} : baseMetrics;
    const batteryInfo = deriveBatteryState(batteryBaseMetrics, batteryMetrics, pctFromVoltage);

    const lastTs = r.ts || null;
    const online = computeOnlineStatus(lastTs, thresholdMs, baseMetrics);

    let warning = '';
    let warningColor = '';
    if (!lastTs) {
      warning = 'No data';
      warningColor = '#666';
    } else if (!batteryInfo.isMains && batteryInfo.isBatteryPct) {
      if (batteryInfo.batteryPct < 10) {
        warning = 'battery very low';
        warningColor = '#c62828';
      } else if (batteryInfo.batteryPct < 25) {
        warning = 'battery low';
        warningColor = '#ef6c00';
      }
    }

    return {
      device: r.display_name || r.external_id,
      batteryText: batteryInfo.batteryText,
      batteryColor: batteryInfo.batteryColor,
      online,
      lastTs,
      warning,
      warningColor
    };
  });
  return msg;
}

module.exports = {
  ingest: {
    normalizeMqtt,
    parseJsonZigbeeTolerant
  },
  mapping: {
    extractAllFields,
    formatReferenceSuggestions,
    normalizeDeviceReferenceCreateInput,
    normalizeDeviceReferenceUpdateInput,
    formatDeviceReferences
  },
  api: {
    parseDeviceReferenceSuggestionFilters,
    parseDeviceReferenceListFilters,
    normalizeApiDeviceReferenceMappingFieldsRequest,
    normalizeApiDeviceReferenceMappingsReplaceRequest,
    normalizeApiDeviceReferenceCreateRequest,
    normalizeApiDeviceReferenceUpdateRequest,
    normalizeDeviceReferenceLinkInput,
    formatDeviceReferenceMappingFields,
    formatDeviceReferenceMappingsReplace,
    formatSingleDeviceReference,
    wrapApiData,
    setApiError
  },
  metrics: {
    applyMappings
  },
  dashboard: {
    buildActivityChartPoints,
    updateActivityHistogram,
    setActivitySource,
    setActivityRange,
    setPeriodicRange,
    setPeriodicBucket,
    triggerPeriodicQueries,
    formatAllDevices,
    formatActuatorStatus,
    buildToggleCommand,
    formatEventChanges,
    formatPeriodicChartsByDevice,
    formatBatteryStatus
  }
};
