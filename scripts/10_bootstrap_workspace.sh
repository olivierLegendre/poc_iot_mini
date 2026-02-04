#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
mkdir -p "$ROOT"/{stack,scripts,docs,evidence/{photos,screenshots,logs,configs,exports}}
echo "Workspace ready at: $ROOT"
