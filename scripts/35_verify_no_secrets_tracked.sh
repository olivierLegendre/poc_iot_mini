#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: $ROOT is not inside a git repository."
  exit 1
fi

patterns=(
  '^stack/\.env$'
  '^stack/mosquitto/passwordfile$'
  '^stack/chirpstack/chirpstack\.toml$'
  '^stack/gateway-bridge/chirpstack-gateway-bridge\.toml$'
  '^stack/zigbee2mqtt/configuration\.yaml$'
  '^stack/zigbee2mqtt/configuration_backup_v[0-9]+\.yaml$'
  '^stack/zigbee2mqtt/state\.json$'
  '^stack/zigbee2mqtt/log/'
  '^stack/gateway-bridge/certs/.*\.(key|csr|srl|crt)$'
)

violations=()
while IFS= read -r file; do
  for pattern in "${patterns[@]}"; do
    if [[ "$file" =~ $pattern ]]; then
      violations+=("$file")
      break
    fi
  done
done < <(git ls-files)

if (( ${#violations[@]} > 0 )); then
  echo "ERROR: sensitive files are tracked by git:"
  printf '  - %s\n' "${violations[@]}"
  echo ""
  echo "Remove them from git history and ensure .gitignore covers them."
  exit 2
fi

echo "OK: no tracked sensitive files detected."
