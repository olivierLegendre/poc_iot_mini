#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash scripts/helpers/runtime_check.sh [--brief | --verbose] [ROOT]

Options:
  --brief    Print only warnings, failures, and the final summary.
  --verbose  Print extra container details and matching log lines on warnings.
  -h, --help Show this help.
EOF
}

MODE="normal"
ROOT_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --brief)
      if [[ "$MODE" == "verbose" ]]; then
        echo "ERROR: --brief and --verbose cannot be used together"
        exit 1
      fi
      MODE="brief"
      ;;
    --verbose)
      if [[ "$MODE" == "brief" ]]; then
        echo "ERROR: --brief and --verbose cannot be used together"
        exit 1
      fi
      MODE="verbose"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -n "$ROOT_ARG" ]]; then
        echo "ERROR: unexpected argument '$1'"
        usage
        exit 1
      fi
      ROOT_ARG="$1"
      ;;
  esac
  shift
done

ROOT="${ROOT_ARG:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
COMPOSE_FILE="$ROOT/stack/docker-compose.yml"
ENV_FILE="$ROOT/stack/.env"
TAIL_LINES="${TAIL_LINES:-120}"

FAILURES=0
WARNINGS=0

is_brief() {
  [[ "$MODE" == "brief" ]]
}

is_verbose() {
  [[ "$MODE" == "verbose" ]]
}

log_info() {
  if ! is_brief; then
    printf '%s\n' "$1"
  fi
}

section() {
  if ! is_brief; then
    printf '\n== %s ==\n' "$1"
  fi
}

warn() {
  printf 'WARN: %s\n' "$1"
  WARNINGS=$((WARNINGS + 1))
}

fail() {
  printf 'FAIL: %s\n' "$1"
  FAILURES=$((FAILURES + 1))
}

compose_all() {
  local args=("-f" "$COMPOSE_FILE")
  local profiles
  local profile

  profiles="$(read_env_var "COMPOSE_PROFILES" || true)"
  if [[ -n "$profiles" ]]; then
    for profile in ${profiles//,/ }; do
      profile="${profile//[[:space:]]/}"
      if [[ -n "$profile" ]]; then
        args+=("--profile" "$profile")
      fi
    done
  fi

  docker compose "${args[@]}" "$@"
}

read_env_var() {
  local key="$1"
  local value

  if [[ ! -f "$ENV_FILE" ]]; then
    return 1
  fi

  value="$(sed -n "s/^[[:space:]]*${key}=//p" "$ENV_FILE" | tail -n 1)"
  if [[ -z "$value" ]]; then
    return 1
  fi

  printf '%s' "$value"
}

is_zigbee_expected() {
  [[ -f "$ENV_FILE" ]] && grep -Eq '^[[:space:]]*COMPOSE_PROFILES=.*zigbee' "$ENV_FILE"
}

check_container() {
  local label="$1"
  local container="$2"
  local required="$3"
  local expect_health="$4"
  local state
  local runtime
  local health

  if ! state="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}' "$container" 2>/dev/null)"; then
    if [[ "$required" == "yes" ]]; then
      fail "$label container '$container' was not found"
    else
      warn "$label container '$container' was not found"
    fi
    return
  fi

  runtime="$(awk '{print $1}' <<<"$state")"
  health="$(awk '{print $2}' <<<"$state")"
  log_info "$(printf '%-26s status=%-10s health=%s' "$label" "$runtime" "$health")"

  if is_verbose; then
    local details
    details="$(
      docker inspect -f '  image={{.Config.Image}} started={{.State.StartedAt}} restart_count={{.RestartCount}}' "$container" 2>/dev/null || true
    )"
    if [[ -n "$details" ]]; then
      log_info "$details"
    fi
  fi

  if [[ "$runtime" != "running" ]]; then
    if [[ "$required" == "yes" ]]; then
      fail "$label is not running"
    else
      warn "$label is not running"
    fi
  fi

  if [[ "$expect_health" == "yes" && "$health" != "healthy" ]]; then
    fail "$label health is '$health' (expected 'healthy')"
  fi
}

check_http() {
  local label="$1"
  local url="$2"
  local expected="${3:-200}"
  local status

  status="$(
    compose_all exec -T nodered sh -lc \
      "wget -q -S -O /dev/null '$url' 2>&1 | sed -n \"s/^[[:space:]]*HTTP\\/[^[:space:]]*[[:space:]]\\([0-9][0-9][0-9]\\).*/\\1/p\" | head -n 1" \
      2>/dev/null || true
  )"

  status="${status//$'\r'/}"

  if [[ -z "$status" ]]; then
    fail "$label did not return an HTTP status"
    return
  fi

  log_info "$(printf '%-26s HTTP %s' "$label" "$status")"

  if [[ "$status" != "$expected" ]]; then
    fail "$label returned HTTP $status (expected $expected)"
  fi
}

check_command_ok() {
  local label="$1"
  local cmd="$2"

  if compose_all exec -T nodered sh -lc "$cmd" >/dev/null 2>&1; then
    log_info "$(printf '%-26s OK' "$label")"
    return
  fi

  fail "$label failed"
}

check_service_exec_ok() {
  local label="$1"
  local service="$2"
  local cmd="$3"

  if compose_all exec -T "$service" sh -lc "$cmd" >/dev/null 2>&1; then
    log_info "$(printf '%-26s OK' "$label")"
    return
  fi

  fail "$label failed"
}

check_log_errors() {
  local label="$1"
  local service="$2"
  local pattern="$3"
  local logs
  local count

  logs="$(compose_all logs --tail "$TAIL_LINES" "$service" 2>&1 || true)"
  count="$(printf '%s\n' "$logs" | grep -Eci "$pattern" || true)"

  log_info "$(printf '%-26s recent error lines=%s (tail=%s)' "$label" "$count" "$TAIL_LINES")"

  if [[ "$count" -gt 0 ]]; then
    warn "$label has $count recent error-like log lines"
    if is_verbose; then
      printf '%s\n' "$logs" | grep -Ei "$pattern" | tail -n 10 || true
    fi
  fi
}

check_zigbee_tcp() {
  local host="$1"
  local port="$2"

  if timeout 5 bash -lc "exec 3<>/dev/tcp/${host}/${port}" 2>/dev/null; then
    log_info "$(printf '%-26s %s:%s' "Zigbee coordinator TCP" "$host" "$port")"
    return
  fi

  fail "Zigbee coordinator TCP check failed for ${host}:${port}"
}

check_host_tcp() {
  local label="$1"
  local host="$2"
  local port="$3"

  if timeout 5 bash -lc "exec 3<>/dev/tcp/${host}/${port}" 2>/dev/null; then
    log_info "$(printf '%-26s %s:%s' "$label" "$host" "$port")"
    return
  fi

  fail "$label is not reachable on ${host}:${port}"
}

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "ERROR: docker-compose file not found at $COMPOSE_FILE"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker is not installed or not available in PATH"
  exit 1
fi

STACK_BIND_HOST="$(read_env_var "STACK_BIND_HOST" || true)"
STACK_BIND_HOST="${STACK_BIND_HOST:-127.0.0.1}"

POSTGRES_ADMIN_USER="$(read_env_var "POSTGRES_ADMIN_USER" || true)"
POSTGRES_ADMIN_USER="${POSTGRES_ADMIN_USER:-postgres}"

POSTGRES_ADMIN_DB="$(read_env_var "POSTGRES_ADMIN_DB" || true)"
POSTGRES_ADMIN_DB="${POSTGRES_ADMIN_DB:-postgres}"

NODERED_PG_DB="$(read_env_var "NODERED_PG_DB" || true)"
NODERED_PG_DB="${NODERED_PG_DB:-poc_nodered}"

MQTT_PORT_CFG="$(read_env_var "MQTT_PORT" || true)"
MQTT_PORT_CFG="${MQTT_PORT_CFG:-1883}"

POSTGRES_PORT_CFG="$(read_env_var "POSTGRES_PORT" || true)"
POSTGRES_PORT_CFG="${POSTGRES_PORT_CFG:-5432}"

LNS_PORT_CFG="$(read_env_var "LNS_PORT" || true)"
LNS_PORT_CFG="${LNS_PORT_CFG:-3443}"

NODERED_HOST_CFG="$(read_env_var "NODERED_HOST" || true)"
NODERED_HOST_CFG="${NODERED_HOST_CFG:-127.0.0.1}"

NODERED_PORT_CFG="$(read_env_var "NODERED_PORT" || true)"
NODERED_PORT_CFG="${NODERED_PORT_CFG:-1880}"

CHIRPSTACK_HOST_CFG="$(read_env_var "CHIRPSTACK_HOST" || true)"
CHIRPSTACK_HOST_CFG="${CHIRPSTACK_HOST_CFG:-chirpstack}"

CHIRPSTACK_HTTP_PORT_CFG="$(read_env_var "CHIRPSTACK_HTTP_PORT" || true)"
CHIRPSTACK_HTTP_PORT_CFG="${CHIRPSTACK_HTTP_PORT_CFG:-8080}"

CHIRPSTACK_HOST_PORT_CFG="$(read_env_var "CHIRPSTACK_HOST_PORT" || true)"
CHIRPSTACK_HOST_PORT_CFG="${CHIRPSTACK_HOST_PORT_CFG:-8080}"

ZIGBEE2MQTT_HOST_CFG="$(read_env_var "ZIGBEE2MQTT_HOST" || true)"
ZIGBEE2MQTT_HOST_CFG="${ZIGBEE2MQTT_HOST_CFG:-zigbee2mqtt}"

ZIGBEE2MQTT_UI_PORT_CFG="$(read_env_var "ZIGBEE2MQTT_UI_PORT" || true)"
ZIGBEE2MQTT_UI_PORT_CFG="${ZIGBEE2MQTT_UI_PORT_CFG:-8080}"

ZIGBEE2MQTT_HOST_PORT_CFG="$(read_env_var "ZIGBEE2MQTT_HOST_PORT" || true)"
ZIGBEE2MQTT_HOST_PORT_CFG="${ZIGBEE2MQTT_HOST_PORT_CFG:-8081}"

section "Compose Status"
if ! is_brief; then
  compose_all ps -a
fi

section "Container Health"
check_container "postgres" "postgres" "yes" "yes"
check_container "redis" "redis" "yes" "yes"
check_container "mosquitto" "mosquitto" "yes" "yes"
check_container "chirpstack" "chirpstack" "yes" "no"
check_container "gateway-bridge" "chirpstack-gateway-bridge" "yes" "no"
check_container "nodered" "nodered" "yes" "yes"

if is_zigbee_expected; then
  check_container "zigbee2mqtt" "zigbee2mqtt" "yes" "no"
else
  check_container "zigbee2mqtt" "zigbee2mqtt" "no" "no"
fi

section "HTTP Endpoints"
check_http "Node-RED editor" "http://${NODERED_HOST_CFG}:${NODERED_PORT_CFG}/"
check_http "FlowFuse dashboard" "http://${NODERED_HOST_CFG}:${NODERED_PORT_CFG}/dashboard/"
check_http "Device refs API" "http://${NODERED_HOST_CFG}:${NODERED_PORT_CFG}/api/v1/device-references"
check_http "ChirpStack UI" "http://${CHIRPSTACK_HOST_CFG}:${CHIRPSTACK_HTTP_PORT_CFG}/"

if docker inspect zigbee2mqtt >/dev/null 2>&1; then
  if [[ "$(docker inspect -f '{{.State.Status}}' zigbee2mqtt 2>/dev/null || true)" == "running" ]]; then
    check_http "Zigbee2MQTT UI" "http://${ZIGBEE2MQTT_HOST_CFG}:${ZIGBEE2MQTT_UI_PORT_CFG}/"
  fi
fi

section "Service Readiness"
check_service_exec_ok "Postgres pg_isready" "postgres" "pg_isready -U ${POSTGRES_ADMIN_USER} -d ${POSTGRES_ADMIN_DB}"
check_service_exec_ok "Redis ping" "redis" "redis-cli ping | grep -qx PONG"
check_service_exec_ok "Mosquitto process" "mosquitto" "pidof mosquitto >/dev/null"
check_command_ok "Node-RED lib load" "node -e \"require('/data/lib/repo/index.js'); require('/data/lib/domain/index.js');\""

section "Host Ports"
check_host_tcp "Mosquitto TCP" "$STACK_BIND_HOST" "$MQTT_PORT_CFG"
check_host_tcp "Postgres TCP" "$STACK_BIND_HOST" "$POSTGRES_PORT_CFG"
check_host_tcp "ChirpStack TCP" "$STACK_BIND_HOST" "$CHIRPSTACK_HOST_PORT_CFG"
check_host_tcp "Gateway bridge TCP" "$STACK_BIND_HOST" "$LNS_PORT_CFG"
check_host_tcp "Node-RED TCP" "$STACK_BIND_HOST" "$NODERED_PORT_CFG"

if docker inspect zigbee2mqtt >/dev/null 2>&1; then
  if [[ "$(docker inspect -f '{{.State.Status}}' zigbee2mqtt 2>/dev/null || true)" == "running" ]]; then
    check_host_tcp "Zigbee2MQTT TCP" "$STACK_BIND_HOST" "$ZIGBEE2MQTT_HOST_PORT_CFG"
  fi
fi

section "Database Summary"
if is_brief; then
  compose_all exec -T postgres psql -U "$POSTGRES_ADMIN_USER" -d "$NODERED_PG_DB" -At -c "
SELECT
  (SELECT count(*) FROM poc.devices),
  (SELECT count(*) FROM poc.device_reference),
  (SELECT count(*) FROM poc.device_reference_mapping),
  (SELECT count(*) FROM poc.telemetry),
  (SELECT count(*) FROM poc.metrics);
" >/dev/null
else
  compose_all exec -T postgres psql -U "$POSTGRES_ADMIN_USER" -d "$NODERED_PG_DB" -c "
SELECT
  (SELECT count(*) FROM poc.devices) AS devices,
  (SELECT count(*) FROM poc.device_reference) AS references,
  (SELECT count(*) FROM poc.device_reference_mapping) AS mappings,
  (SELECT count(*) FROM poc.telemetry) AS telemetry_rows,
  (SELECT count(*) FROM poc.metrics) AS metric_rows;
"
fi

section "Recent Logs"
check_log_errors "Node-RED" "nodered" '\\[error\\]|\\berror\\b'
check_log_errors "ChirpStack" "chirpstack" '\\bERROR\\b|\\berror\\b'
check_log_errors "Gateway bridge" "chirpstack-gateway-bridge" '\\bERROR\\b|\\berror\\b'
check_log_errors "Mosquitto" "mosquitto" '\\berror\\b|\\bdenied\\b'

if docker inspect zigbee2mqtt >/dev/null 2>&1; then
  check_log_errors "Zigbee2MQTT" "zigbee2mqtt" '\\berror\\b'
fi

SLZB06_IP="$(read_env_var "SLZB06_IP" || true)"
SLZB06_PORT="$(read_env_var "SLZB06_PORT" || true)"

if [[ -n "$SLZB06_IP" && -n "$SLZB06_PORT" ]]; then
  section "Zigbee Adapter"
  check_zigbee_tcp "$SLZB06_IP" "$SLZB06_PORT"
fi

section "Summary"
printf 'Failures: %s\n' "$FAILURES"
printf 'Warnings: %s\n' "$WARNINGS"

if [[ "$FAILURES" -gt 0 ]]; then
  exit 1
fi
