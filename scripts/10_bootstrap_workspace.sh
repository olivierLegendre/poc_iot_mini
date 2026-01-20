#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$HOME/Public/poc}"
mkdir -p "$ROOT"/{stack,scripts,docs,evidence/{photos,screenshots,logs,configs,exports}}
echo "Workspace ready at: $ROOT"
