#!/bin/bash
# DMG deploy: swaps /Applications/T3 Code (Alpha).app for the fork DMG built
# from HEAD, retargets ~/.t3/fork/current at the staged payload for HEAD so
# the relaunched app runs it, relaunches the app, then restarts the fork t3
# server on each remote host. Needed only when choose-deploy-path.sh prints
# dmg. Server, web, and mobile changes are swap-fork-payload.sh — the app
# stays up.
#
# Usage: swap-fork-app.sh [version] [--local-only] [--force]
#   version defaults to apps/desktop/package.json. --force DMG-swaps even
#   when choose-deploy-path prints payload.
#
# --local-only skips the forced remote restart. Unlike the payload script's
# flag, nothing converges lazily here unless the tarball was also shipped:
# the remotes keep whatever build their spec names until the next deploy.
# Detaches itself (lib.sh detach_self): quitting the app kills every session
# it hosts, including the agent running this. Progress and the final
# "deploy complete" line land in ~/.t3/fork/deploy.log.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

VERSION="$(node -p "require('$REPO/apps/desktop/package.json').version")"
FORCE=""
LOCAL_ONLY=""
for arg in "$@"; do
  case "$arg" in
    --local-only) LOCAL_ONLY=1 ;;
    --force) FORCE=1 ;;
    *) VERSION="$arg" ;;
  esac
done
DMG="$REPO/release/T3-Code-${VERSION}-arm64.dmg"
VOL="/Volumes/T3 Code (Alpha) ${VERSION} Installer"
SHA="$(head_sha)"

[ -f "$DMG" ] || { echo "missing DMG: $DMG" >&2; exit 1; }
# A DMG older than the commit it claims to deploy is a leftover of an earlier build.
[ "$(stat -f %m "$DMG")" -ge "$(git -C "$REPO" log -1 --format=%ct HEAD)" ] \
  || { echo "stale DMG: $DMG predates HEAD ($SHA); rebuild it" >&2; exit 1; }
[ -f "$BUILDS_DIR/$SHA/apps/server/dist/bin.mjs" ] \
  || { echo "payload for HEAD ($SHA) not staged; run stage-server-payload.sh first" >&2; exit 1; }
PATH_KIND="$(decide_deploy_path)"
if [ "$PATH_KIND" = payload ] && [ -z "$FORCE" ]; then
  echo "choose-deploy-path: payload — no Electron/native/packaging runtime change since the last payload swap. Use swap-fork-payload.sh, or pass --force to DMG-swap anyway." >&2
  exit 1
fi
detach_self "$@"

echo "deploying the fork as T3 Code (Alpha) $VERSION from $DMG with payload $SHA"
# Head start: let the agent that launched us finish its turn before its host dies.
sleep 8

# Draining hosted sessions and ssh tunnels takes the app ~35s.
osascript -e 'tell application "T3 Code (Alpha)" to quit' || true
for _ in $(seq 1 60); do
  app_running || break
  sleep 1
done
if app_running; then
  echo "app did not quit; aborting before touching $APP" >&2
  exit 1
fi

hdiutil attach -nobrowse -quiet "$DMG"
trap 'hdiutil detach "$VOL" >/dev/null 2>&1 || true' EXIT
rm -rf "$APP"
ditto "$VOL/T3 Code (Alpha).app" "$APP"
hdiutil detach -quiet "$VOL"
trap - EXIT

# The build is unsigned, so the bundle carries only the linker's per-binary
# ad-hoc signatures and no resource seal. Gatekeeper's re-assessment of the
# freshly copied bundle then fails (errSecCSResourcesNotFound) and Launch
# Services never resumes the process `open` spawned. A proper ad-hoc
# signature seals the resources and takes a fraction of a second.
codesign --force --deep --sign - "$APP" 2>&1 | grep -v 'replacing existing signature' || true
codesign --verify --deep --strict "$APP"

# Retarget before relaunch so the new app adopts the payload at launch.
retarget_current "$SHA"

open "$APP"
# If Launch Services still refuses the launch, the user can open the app by
# hand and this script carries on with the rest of the deploy.
for i in $(seq 1 600); do
  app_running && break
  [ "$i" -eq 15 ] && echo "no app process after 15s; open T3 Code (Alpha) by hand — waiting up to 10 minutes"
  sleep 1
done
if ! app_running; then
  echo "app did not come up within 10 minutes" >&2
  exit 1
fi

# The backend child's argv carries the symlink entry path, so its presence
# proves the override was picked up. If it never appears, the app fell back to
# the bundled server — stop before restarting remotes onto a newer build.
PID=""
for _ in $(seq 1 15); do
  sleep 2
  PID="$(backend_pid || true)"
  [ -n "$PID" ] && break
done
if [ -z "$PID" ]; then
  echo "no backend from $CURRENT_LINK after 30s; app is likely on the bundled server — aborting remote restart" >&2
  exit 1
fi
echo "app swapped: binary mtime $(stat -f '%Sm' "$APP_BINARY"); backend pid $PID from build $(live_build "$PID")"

# The DMG is built from the repo tip in the same deploy flow, so HEAD is the
# deployed commit. Record it for the migration gate, plus the DMG marker the
# desktop-change check reads on later payload deploys.
git -C "$REPO" rev-parse HEAD > "$REPO/release/.last-deployed-sha"
git -C "$REPO" rev-parse HEAD > "$REPO/release/.last-dmg-sha"

if [ -z "$LOCAL_ONLY" ]; then
  sleep 20 # let the new app finish launching so it owns the reconnects
  "$DEPLOY_DIR/restart-remote-servers.sh"
else
  echo "local-only: remote servers left on their current build"
fi

prune_builds
echo "deploy complete"
