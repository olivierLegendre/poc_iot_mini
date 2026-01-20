#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:-$HOME/Public/poc}"
cd "$ROOT/stack"
docker compose down
