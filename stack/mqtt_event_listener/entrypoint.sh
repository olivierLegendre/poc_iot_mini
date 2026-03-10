#!/bin/sh
set -eu

MQTT_HOST_VALUE="${MQTT_HOST:-mosquitto}"
MQTT_PORT_VALUE="${MQTT_PORT:-1883}"
MQTT_QOS_VALUE="${MQTT_EVENT_QOS:-0}"
MQTT_USER_VALUE="${MQTT_EVENT_USER:-}"
MQTT_PASS_VALUE="${MQTT_EVENT_PASS:-}"
MQTT_HANDLER_COMMAND_VALUE="${MQTT_EVENT_HANDLER_COMMAND:-}"
MQTT_OUTPUT_RETAIN_VALUE="${MQTT_EVENT_OUTPUT_RETAIN:-true}"
MQTT_LIGHT_TOPIC_VALUE="${MQTT_EVENT_LIGHT_TOPIC:-zigbee2mqtt/hz_light_zigbee_01}"
MQTT_LIGHT_FIELD_VALUE="${MQTT_EVENT_LIGHT_FIELD:-illuminance_lux}"
MQTT_LIGHT_OUTPUT_TOPIC_VALUE="${MQTT_EVENT_LIGHT_OUTPUT_TOPIC:-poc/normalized/luminosite}"
MQTT_OCC_TOPIC_VALUE="${MQTT_EVENT_OCC_TOPIC:-zigbee2mqtt/sonoff_snzb_03p_01}"
MQTT_OCC_FIELD_VALUE="${MQTT_EVENT_OCC_FIELD:-occupancy}"
MQTT_OCC_OUTPUT_TOPIC_VALUE="${MQTT_EVENT_OCC_OUTPUT_TOPIC:-poc/normalized/occupation}"
MQTT_STATE_TOPIC_VALUE="${MQTT_EVENT_STATE_TOPIC:-zigbee2mqtt/nous_a1z_01}"
MQTT_STATE_FIELD_VALUE="${MQTT_EVENT_STATE_FIELD:-state}"
MQTT_STATE_OUTPUT_TOPIC_VALUE="${MQTT_EVENT_STATE_OUTPUT_TOPIC:-poc/normalized/etat_prise}"
TAB_SEPARATOR="$(printf '\t')"

echo "[mqtt_event_listener] waiting for topic updates"
echo "[mqtt_event_listener] broker=${MQTT_HOST_VALUE}:${MQTT_PORT_VALUE} qos=${MQTT_QOS_VALUE}"
echo "[mqtt_event_listener] light=${MQTT_LIGHT_TOPIC_VALUE} -> ${MQTT_LIGHT_OUTPUT_TOPIC_VALUE}"
echo "[mqtt_event_listener] occupancy=${MQTT_OCC_TOPIC_VALUE} -> ${MQTT_OCC_OUTPUT_TOPIC_VALUE}"
echo "[mqtt_event_listener] state=${MQTT_STATE_TOPIC_VALUE} -> ${MQTT_STATE_OUTPUT_TOPIC_VALUE}"

set -- \
  -h "$MQTT_HOST_VALUE" \
  -p "$MQTT_PORT_VALUE" \
  -t "$MQTT_LIGHT_TOPIC_VALUE" \
  -t "$MQTT_OCC_TOPIC_VALUE" \
  -t "$MQTT_STATE_TOPIC_VALUE" \
  -q "$MQTT_QOS_VALUE" \
  -F "%t${TAB_SEPARATOR}%p"

if [ -n "$MQTT_USER_VALUE" ]; then
  set -- "$@" -u "$MQTT_USER_VALUE"
fi

if [ -n "$MQTT_PASS_VALUE" ]; then
  set -- "$@" -P "$MQTT_PASS_VALUE"
fi

extract_json_field() {
  field_name="$1"
  json_payload="$2"

  value="$(printf '%s\n' "$json_payload" | sed -n "s/.*\"${field_name}\":[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" | head -n 1)"
  if [ -n "$value" ]; then
    printf '%s' "$value"
    return 0
  fi

  value="$(printf '%s\n' "$json_payload" | sed -n "s/.*\"${field_name}\":[[:space:]]*\\(true\\|false\\).*/\\1/p" | head -n 1)"
  if [ -n "$value" ]; then
    printf '%s' "$value"
    return 0
  fi

  value="$(printf '%s\n' "$json_payload" | sed -n "s/.*\"${field_name}\":[[:space:]]*\\([-0-9][0-9.]*\\).*/\\1/p" | head -n 1)"
  printf '%s' "$value"
}

publish_message() {
  output_topic="$1"
  output_value="$2"
  retain_flag="$3"

  if [ -z "$output_topic" ] || [ -z "$output_value" ]; then
    return 0
  fi

  if [ -n "$MQTT_USER_VALUE" ] && [ -n "$MQTT_PASS_VALUE" ]; then
    if [ "$retain_flag" = "true" ] || [ "$retain_flag" = "1" ]; then
      mosquitto_pub -h "$MQTT_HOST_VALUE" -p "$MQTT_PORT_VALUE" -u "$MQTT_USER_VALUE" -P "$MQTT_PASS_VALUE" -t "$output_topic" -m "$output_value" -r
    else
      mosquitto_pub -h "$MQTT_HOST_VALUE" -p "$MQTT_PORT_VALUE" -u "$MQTT_USER_VALUE" -P "$MQTT_PASS_VALUE" -t "$output_topic" -m "$output_value"
    fi
  else
    if [ "$retain_flag" = "true" ] || [ "$retain_flag" = "1" ]; then
      mosquitto_pub -h "$MQTT_HOST_VALUE" -p "$MQTT_PORT_VALUE" -t "$output_topic" -m "$output_value" -r
    else
      mosquitto_pub -h "$MQTT_HOST_VALUE" -p "$MQTT_PORT_VALUE" -t "$output_topic" -m "$output_value"
    fi
  fi
}

publish_value() {
  publish_message "$1" "$2" "$MQTT_OUTPUT_RETAIN_VALUE"
}

mosquitto_sub "$@" | while IFS= read -r line; do
  topic="${line%%${TAB_SEPARATOR}*}"
  payload="${line#*${TAB_SEPARATOR}}"
  timestamp="$(date -Iseconds)"
  field_name=""
  output_topic=""

  case "$topic" in
    "$MQTT_LIGHT_TOPIC_VALUE")
      field_name="$MQTT_LIGHT_FIELD_VALUE"
      output_topic="$MQTT_LIGHT_OUTPUT_TOPIC_VALUE"
      ;;
    "$MQTT_OCC_TOPIC_VALUE")
      field_name="$MQTT_OCC_FIELD_VALUE"
      output_topic="$MQTT_OCC_OUTPUT_TOPIC_VALUE"
      ;;
    "$MQTT_STATE_TOPIC_VALUE")
      field_name="$MQTT_STATE_FIELD_VALUE"
      output_topic="$MQTT_STATE_OUTPUT_TOPIC_VALUE"
      ;;
  esac

  value=""
  if [ -n "$field_name" ]; then
    value="$(extract_json_field "$field_name" "$payload")"
  fi

  echo "[mqtt_event_listener] ${timestamp} topic=${topic} payload=${payload}"

  if [ -n "$value" ] && [ -n "$output_topic" ]; then
    publish_value "$output_topic" "$value"
    echo "[mqtt_event_listener] published ${output_topic}=${value}"
  fi

  if [ -n "$MQTT_HANDLER_COMMAND_VALUE" ]; then
    MQTT_EVENT_LAST_TOPIC="$topic" \
    MQTT_EVENT_LAST_PAYLOAD="$payload" \
    MQTT_EVENT_LAST_TIMESTAMP="$timestamp" \
    MQTT_EVENT_LAST_VALUE="$value" \
    sh -c "$MQTT_HANDLER_COMMAND_VALUE" || echo "[mqtt_event_listener] handler command failed"
  fi
done
