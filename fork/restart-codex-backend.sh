#!/bin/sh
set -eu

launcher="$HOME/.t3/codex-shared/codex-shared"
if [ ! -x "$launcher" ]; then
  echo "Shared Codex launcher is not installed at $launcher. See SHARED_CODEX.md." >&2
  exit 1
fi
exec "$launcher" shared-restart
