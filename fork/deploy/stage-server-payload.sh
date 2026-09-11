#!/bin/bash
# Stages the fork server tarball as a desktop payload under
# ~/.t3/fork/builds/<sha>/. Staging is inert: nothing runs from the directory
# until a swap script retargets ~/.t3/fork/current at it (fork feature:
# desktop server payload override). Layout mirrors the bundled server root
# that backendEntryPath expects: apps/server/dist + node_modules resolved from
# the payload root.
#
# Usage: stage-server-payload.sh [tarball-path]
# Builds the tarball via pack-server-tarball.sh when omitted. Safe to run from
# inside the app. Prints the payload directory as the last stdout line.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

SHA="$(head_sha)"
TARBALL="${1:-$("$DEPLOY_DIR/pack-server-tarball.sh" | tail -1)}"
DIR="$BUILDS_DIR/$SHA"

[ -f "$TARBALL" ] || { echo "missing tarball: $TARBALL" >&2; exit 1; }
# The live build may be in use by the running backend; never rebuild it in place.
if [ "$(readlink "$CURRENT_LINK" 2>/dev/null || true)" = "builds/$SHA" ]; then
  echo "refusing to restage builds/$SHA: it is the live payload" >&2
  exit 1
fi
echo "staging $TARBALL as desktop payload $SHA" >&2

rm -rf "$DIR"
mkdir -p "$DIR/apps/server"
tar -xzf "$TARBALL" -C "$DIR"
mv "$DIR/package/dist" "$DIR/apps/server/dist"
mv "$DIR/package/package.json" "$DIR/package.json"
rm -rf "$DIR/package"
# A fresh resolution drifts with the registry: on 2026-09-11 it picked
# @effect/platform-node-shared rc.114, whose own range wants an unpublished
# effect rc.114, and staging died. Carry the live build's lockfile forward so
# unchanged dependencies stay where they are; npm reconciles whatever the
# manifest changed since.
LIVE_DIR="$BUILDS_DIR/$(basename "$(readlink "$CURRENT_LINK" 2>/dev/null || echo none)")"
if [ -f "$LIVE_DIR/package-lock.json" ]; then
  cp "$LIVE_DIR/package-lock.json" "$DIR/package-lock.json"
fi
(cd "$DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error >&2)

[ -f "$DIR/apps/server/dist/bin.mjs" ] || { echo "staging failed: bin.mjs missing" >&2; exit 1; }
[ -f "$DIR/apps/server/dist/client/index.html" ] || { echo "staging failed: web client missing" >&2; exit 1; }

echo "staged; live payload is still $(readlink "$CURRENT_LINK" 2>/dev/null || echo '<none>')" >&2
echo "$DIR"
