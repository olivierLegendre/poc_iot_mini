'use strict';

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

function normalizeMqtt(msg, flow) {
  const staticIeeeByFriendly = {
    hz_light_zigbee_01: '0xa4c1384a6572348b',
    nous_a1z_01: '0xa4c1389274f470fa',
    sonoff_snzb_03p_01: '0xf044d3fffe9171eb',
    sonff_snzb_03p_01: '0xf044d3fffe9171eb'
  };

  const topic = msg.topic || '';
  const payload = (typeof msg.payload === 'object' && msg.payload) ? msg.payload : { raw: msg.payload };
  const zigbeeByFriendly = flow.get('zigbeeByFriendly') || {};

  const out = {
    source: 'unknown',
    deviceId: 'unknown',
    displayName: null,
    eventType: 'unknown',
    ts: isoNow(),
    topic,
    metrics: {},
    raw: payload
  };

  if (topic === 'zigbee2mqtt/bridge/devices' && Array.isArray(payload)) {
    for (const device of payload) {
      const ieee = canonicalIeee(device && (device.ieee_address || device.ieeeAddr));
      const friendly = device && device.friendly_name;
      if (ieee && typeof friendly === 'string' && friendly.length > 0) {
        zigbeeByFriendly[friendly] = ieee;
      }
    }
    flow.set('zigbeeByFriendly', zigbeeByFriendly);
    return null;
  }

  if (topic.startsWith('zigbee2mqtt/bridge/event')) {
    const data = (payload && payload.data) || {};
    const ieee = canonicalIeee(data.ieee_address || data.ieeeAddr);
    const friendly = data.friendly_name;
    if (ieee && typeof friendly === 'string' && friendly.length > 0) {
      zigbeeByFriendly[friendly] = ieee;
      flow.set('zigbeeByFriendly', zigbeeByFriendly);
    }
    return null;
  }

  if (topic.startsWith('zigbee2mqtt/')) {
    const parts = topic.split('/');
    if (parts.length >= 2 && parts[1] !== 'bridge') {
      const topicDevice = parts[1];
      let ieee = canonicalIeee(payload.ieee_address || payload.ieeeAddr);
      if (!ieee && isIeeeAddress(topicDevice)) ieee = topicDevice.toLowerCase();
      if (!ieee && zigbeeByFriendly[topicDevice]) ieee = zigbeeByFriendly[topicDevice];
      if (!ieee && staticIeeeByFriendly[topicDevice]) ieee = staticIeeeByFriendly[topicDevice];

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
      out.eventType = 'state';
      out.metrics = payload;
      out.ts = asIso(payload.last_seen);
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
  flow.set('periodic_range', msg.payload || '1h');
  return { payload: 'refresh' };
}

function setPeriodicBucket(msg, flow) {
  flow.set('periodic_bucket', msg.payload || '1 minute');
  return { payload: 'refresh' };
}

function triggerPeriodicQueries() {
  return [
    { sensor: 'zigbee_temp_humidity' },
    { sensor: '0xa4c1384a6572348b' },
    { sensor: 'l_temp_dragino_t68dl' }
  ];
}

function formatAllDevices(msg, deps) {
  const rows = Array.isArray(msg.payload) ? msg.payload : [];
  const thresholdMs = thresholdMsFromEnv(deps && deps.env);

  msg.payload = rows.map((r) => {
    const metrics = { ...(r.metrics || {}) };
    if ((metrics.battery === undefined || metrics.battery === null) && metrics.battery_percentage !== undefined) {
      metrics.battery = metrics.battery_percentage;
    }

    const summary = ['state', 'relay', 'door_open', 'occupancy', 'motion', 'temperature', 'humidity', 'illuminance', 'battery']
      .filter((k) => metrics[k] !== undefined)
      .map((k) => `${k}: ${metrics[k]}`)
      .join(' | ') || 'No telemetry yet';

    const lastTs = r.last_ts || r.last_seen_at || null;
    const lastMs = lastTs ? Date.parse(lastTs) : NaN;
    const online = Number.isFinite(lastMs) && (Date.now() - lastMs) <= thresholdMs;

    return {
      device: r.display_name || r.external_id,
      network: r.network || 'n/a',
      lastTs,
      online,
      summary
    };
  });
  return msg;
}

function formatActuatorStatus(msg, deps) {
  const rows = Array.isArray(msg.payload) ? msg.payload : [];
  const byId = new Map(rows.map((r) => [r.external_id, r]));
  const devices = [
    { id: '0xa4c1389274f470fa', label: 'nous_a1z_01' },
    { id: 'a1a2a3a4a5a6a7a8', label: 'l_plug_milesight_ws513' }
  ];
  const thresholdMs = thresholdMsFromEnv(deps && deps.env);
  const pctFromVoltage = deps && deps.batteryHelpers && deps.batteryHelpers.pctFromVoltage;

  const voltageProfiles = {
    'l_temp_dragino_t68dl': { min: 2.6, max: 3.0 },
    '0102030405060708': { min: 2.6, max: 3.0 },
    'l_contact_dragino_lds02': { min: 2.1, max: 3.0 },
    '1122334455667788': { min: 2.1, max: 3.0 }
  };

  const mainsDevices = new Set([
    '0xa4c1389274f470fa',
    'l_plug_milesight_ws513',
    'a1a2a3a4a5a6a7a8'
  ]);

  msg.payload = devices.map((device) => {
    const r = byId.get(device.id);
    const lastTs = r && r.ts ? r.ts : null;
    if (!lastTs) {
      return {
        id: device.id,
        label: (r && r.display_name) || device.label || device.id,
        lastTs: null,
        online: false,
        unavailable: true,
        batteryText: 'n/a',
        batteryColor: '#9e9e9e'
      };
    }

    const m = (r && r.metrics) || {};
    const deviceId = String((r && r.external_id) || device.id).toLowerCase();
    const displayName = String((r && r.display_name) || device.label || device.id).toLowerCase();

    const batteryPctVal = (m.battery !== undefined && m.battery !== null)
      ? m.battery
      : ((m.battery_percentage !== undefined && m.battery_percentage !== null) ? m.battery_percentage : null);
    const batteryPctRaw = batteryPctVal !== null ? Number(batteryPctVal) : null;
    const batteryVRaw = (m.battery_v !== undefined && m.battery_v !== null) ? m.battery_v : (m.object && m.object.battery_v);
    const hasPct = Number.isFinite(batteryPctRaw);
    const hasV = batteryVRaw !== undefined && batteryVRaw !== null && Number.isFinite(Number(batteryVRaw));

    const powerSource = String(m.power_source || '').toLowerCase();
    const isMains = mainsDevices.has(deviceId) || mainsDevices.has(displayName)
      || powerSource === 'mains' || powerSource === 'main' || m.mains === true || m.mains_powered === true;

    let batteryPct = hasPct ? batteryPctRaw : null;
    if (!hasPct && hasV) {
      const profile = voltageProfiles[deviceId] || voltageProfiles[displayName] || null;
      batteryPct = pctFromVoltageSafe(batteryVRaw, profile, pctFromVoltage);
    }

    const isBatteryPct = Number.isFinite(batteryPct);
    const batteryText = isMains
      ? 'main-powered'
      : (isBatteryPct
        ? `${batteryPct}%`
        : (hasV ? `${Number(batteryVRaw).toFixed(2)} V` : 'n/a'));

    const lastMs = Date.parse(lastTs);
    const online = Number.isFinite(lastMs) && (Date.now() - lastMs) <= thresholdMs;

    return {
      id: device.id,
      label: (r && r.display_name) || device.label || device.id,
      lastTs,
      online,
      unavailable: false,
      batteryText,
      batteryColor: isMains ? '#2e7d32' : (isBatteryPct ? batteryColor(batteryPct) : '#9e9e9e')
    };
  });
  return msg;
}

function buildToggleCommand(msg) {
  const row = Array.isArray(msg.payload) ? msg.payload[0] : null;
  if (!row) {
    return null;
  }
  const m = row.metrics || {};

  if (row.network === 'zigbee') {
    const current = String(m.state || 'OFF').toUpperCase();
    const next = current === 'ON' ? 'OFF' : 'ON';

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

    msg.topic = topicBase + '/set';
    msg.payload = { state: next };
  } else if (row.network === 'lorawan') {
    const current = Number(m.relay || 0);
    const next = current === 1 ? 0 : 1;
    const devEui = String(row.external_id || '').toLowerCase();
    msg.topic = 'application/1/device/' + devEui + '/command/down';
    msg.payload = { fPort: 85, confirmed: true, data: next === 1 ? 'AQ==' : 'AA==' };
  }

  return msg;
}

function formatEventChanges(msg, deps) {
  const rows = Array.isArray(msg.payload) ? msg.payload : [];
  const thresholdMs = thresholdMsFromEnv(deps && deps.env);
  const devices = [
    { id: '0xf044d3fffe9171eb', label: 'sonoff_snzb_03p_01' },
    { id: '1122334455667788', label: 'l_contact_dragino_lds02' }
  ];

  const byId = new Map();
  for (const row of rows) {
    const id = row.external_id;
    if (!byId.has(id)) {
      byId.set(id, { id, label: row.display_name || null, lastTs: row.last_ts || null, online: false, events: [] });
    }
    const entry = byId.get(id);
    if (!entry.lastTs && row.last_ts) {
      entry.lastTs = row.last_ts;
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

  const items = devices.map((device) => {
    const entry = byId.get(device.id) || { id: device.id, label: device.label, lastTs: null, online: false, events: [] };
    const lastMs = entry.lastTs ? Date.parse(entry.lastTs) : NaN;
    entry.online = Number.isFinite(lastMs) && (Date.now() - lastMs) <= thresholdMs;
    entry.label = entry.label || device.label || device.id;
    return entry;
  });

  msg.payload = items;
  return msg;
}

function buildPeriodicThChart(msg) {
  const rows = Array.isArray(msg.payload) ? msg.payload : [];
  const tempPoints = [];
  const humPoints = [];

  for (const r of rows) {
    const series = r.series || 'value';
    const point = { x: new Date(r.bucket).getTime(), y: Number(r.value || 0) };
    if (series === 'temperature') tempPoints.push(point);
    else if (series === 'humidity') humPoints.push(point);
  }

  return [
    { topic: 'temperature', payload: tempPoints, action: 'replace' },
    { topic: 'humidity', payload: humPoints, action: 'replace' }
  ];
}

function buildPeriodicGroupedChart(msg) {
  const rows = Array.isArray(msg.payload) ? msg.payload : [];
  const grouped = {};

  for (const r of rows) {
    const series = r.series || 'value';
    if (!grouped[series]) {
      grouped[series] = [];
    }
    grouped[series].push({ x: new Date(r.bucket).getTime(), y: Number(r.value || 0) });
  }

  return Object.entries(grouped).map(([series, points]) => ({
    topic: series,
    payload: points,
    action: 'replace'
  }));
}

function formatBatteryStatus(msg, deps) {
  const rows = Array.isArray(msg.payload) ? msg.payload : [];
  const thresholdMs = thresholdMsFromEnv(deps && deps.env);
  const pctFromVoltage = deps && deps.batteryHelpers && deps.batteryHelpers.pctFromVoltage;

  const voltageProfiles = {
    'l_temp_dragino_t68dl': { min: 2.6, max: 3.0 },
    '0102030405060708': { min: 2.6, max: 3.0 },
    'l_contact_dragino_lds02': { min: 2.1, max: 3.0 },
    '1122334455667788': { min: 2.1, max: 3.0 }
  };

  const mainsDevices = new Set([
    '0xa4c1389274f470fa',
    'l_plug_milesight_ws513',
    'a1a2a3a4a5a6a7a8'
  ]);

  const pick = (obj, key) => (obj && obj[key] !== undefined && obj[key] !== null) ? obj[key] : undefined;

  msg.payload = rows.map((r) => {
    const baseMetrics = r.metrics || {};
    const batteryMetrics = r.battery_metrics || {};
    const deviceId = String(r.external_id || '').toLowerCase();
    const displayName = String(r.display_name || '').toLowerCase();

    const batteryPctVal = pick(baseMetrics, 'battery') ?? pick(baseMetrics, 'battery_percentage')
      ?? pick(batteryMetrics, 'battery') ?? pick(batteryMetrics, 'battery_percentage');
    const batteryPctRaw = batteryPctVal !== undefined ? Number(batteryPctVal) : null;

    const batteryVRaw = (baseMetrics.battery_v !== undefined && baseMetrics.battery_v !== null)
      ? baseMetrics.battery_v
      : ((baseMetrics.object && baseMetrics.object.battery_v !== undefined && baseMetrics.object.battery_v !== null)
        ? baseMetrics.object.battery_v
        : ((batteryMetrics.battery_v !== undefined && batteryMetrics.battery_v !== null)
          ? batteryMetrics.battery_v
          : (batteryMetrics.object && batteryMetrics.object.battery_v)));

    const hasPct = Number.isFinite(batteryPctRaw);
    const hasV = batteryVRaw !== undefined && batteryVRaw !== null && Number.isFinite(Number(batteryVRaw));

    const powerSource = String(baseMetrics.power_source || batteryMetrics.power_source || '').toLowerCase();
    const isMains = mainsDevices.has(deviceId) || mainsDevices.has(displayName)
      || powerSource === 'mains' || powerSource === 'main'
      || baseMetrics.mains === true || baseMetrics.mains_powered === true
      || batteryMetrics.mains === true || batteryMetrics.mains_powered === true;

    let batteryPct = hasPct ? batteryPctRaw : null;
    if (!hasPct && hasV) {
      const profile = voltageProfiles[deviceId] || voltageProfiles[displayName] || null;
      batteryPct = pctFromVoltageSafe(batteryVRaw, profile, pctFromVoltage);
    }

    const isBatteryPct = Number.isFinite(batteryPct);
    const batteryText = isMains
      ? 'main-powered'
      : (isBatteryPct
        ? `${batteryPct}%`
        : (hasV ? `${Number(batteryVRaw).toFixed(2)} V` : 'n/a'));

    const lastTs = r.ts || null;
    const lastMs = lastTs ? Date.parse(lastTs) : NaN;
    const online = Number.isFinite(lastMs) && (Date.now() - lastMs) <= thresholdMs;

    let warning = '';
    let warningColor = '';
    if (!lastTs) {
      warning = 'No data';
      warningColor = '#666';
    } else if (!isMains && isBatteryPct) {
      if (batteryPct < 10) {
        warning = 'battery very low';
        warningColor = '#c62828';
      } else if (batteryPct < 25) {
        warning = 'battery low';
        warningColor = '#ef6c00';
      }
    }

    return {
      device: r.display_name || r.external_id,
      batteryText,
      batteryColor: isMains ? '#2e7d32' : (isBatteryPct ? batteryColor(batteryPct) : '#9e9e9e'),
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
    extractAllFields
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
    buildPeriodicThChart,
    buildPeriodicGroupedChart,
    formatBatteryStatus
  }
};
