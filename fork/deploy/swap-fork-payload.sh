#!/bin/bash
# Payload deploy: retargets ~/.t3/fork/current at the staged build for <sha>,
# restarts the desktop's backend child in place, then restarts the fork t3
# server on each remote host. The app keeps running; the window shows the new
# frontend on its next reload (Cmd+R). This is the default deploy path.
# Use swap-fork-app.sh only when choose-deploy-path.sh prints dmg.
#
# Usage: swap-fork-payload.sh [sha] [--local-only] [--force]
#   sha defaults to HEAD. --force payload-swaps even when choose-deploy-path
#   prints dmg.
# Detaches itself (lib.sh detach_self): restarting the backend kills every
# session it hosts, including the agent running this. Progress and the final
# "deploy complete" line land in ~/.t3/fork/deploy.log.
#
# --local-only skips the forced remote restart; remotes still converge lazily
# because the ssh-launch runner shim embeds the package spec, and a changed
# shim restarts the server on the next reconnect.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

SHA="$(head_sha)"
LOCAL_ONLY=""
FORCE=""
for arg in "$@"; do
  case "$arg" in
    --local-only) LOCAL_ONLY=1 ;;
    --force) FORCE=1 ;;
    *) SHA="$arg" ;;
  esac
done
READY_PATH="/.well-known/t3/environment"

[ -f "$BUILDS_DIR/$SHA/apps/server/dist/bin.mjs" ] \
  || { echo "missing payload: $BUILDS_DIR/$SHA" >&2; exit 1; }
PATH_KIND="$(decide_deploy_path)"
if [ "$PATH_KIND" = dmg ] && [ -z "$FORCE" ]; then
  echo "choose-deploy-path: dmg — Electron/native/packaging runtime files changed since the last payload swap. Use swap-fork-app.sh, or pass --force to payload-swap anyway." >&2
  exit 1
fi
OLD_PID="$(backend_pid || true)"
if [ -z "$OLD_PID" ]; then
  echo "no backend running from $CURRENT_LINK: the app is down, or it predates the symlink override — use swap-fork-app.sh" >&2
  exit 1
fi
detach_self "$@"

echo "deploying payload $SHA: backend pid $OLD_PID restarts in place"
# Head start: let the agent that launched us finish its turn before its session dies.
sleep 8

retarget_current "$SHA"
kill "$OLD_PID"
# The supervisor only ever kills on an explicit stop, so escalate ourselves if
# the server's SIGTERM handler hangs.
for _ in $(seq 1 10); do
  kill -0 "$OLD_PID" 2>/dev/null || break
  sleep 1
done
if kill -0 "$OLD_PID" 2>/dev/null; then
  echo "backend pid $OLD_PID ignored SIGTERM for 10s; sending SIGKILL"
  kill -9 "$OLD_PID"
fi

NEW_PID=""
for _ in $(seq 1 30); do
  sleep 1
  pid="$(backend_pid || true)"
  if [ -n "$pid" ] && [ "$pid" != "$OLD_PID" ]; then NEW_PID="$pid"; break; fi
done
[ -n "$NEW_PID" ] || { echo "no replacement backend after 30s; inspect the app's backend log" >&2; exit 1; }

PORT=""
for _ in $(seq 1 60); do
  PORT="$(listen_port "$NEW_PID" || true)"
  [ -n "$PORT" ] && break
  sleep 1
done
[ -n "$PORT" ] || { echo "backend pid $NEW_PID not listening after 60s" >&2; exit 1; }
# Any HTTP answer proves the server is up; the endpoint may reject an
# unauthenticated probe, and that is still an answer.
code="000"
for _ in $(seq 1 30); do
  # A probe that connects while the server is still booting can be parked
  # forever (2026-09-04: a curl with no timeout hung the deploy for 20 min);
  # bound it so the loop retries instead.
  code="$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$READY_PATH" || true)"
  [ "$code" != "000" ] && break
  sleep 1
done
[ "$code" != "000" ] || { echo "backend pid $NEW_PID on port $PORT not answering after 30s" >&2; exit 1; }
LIVE="$(live_build "$NEW_PID" || true)"
[ "$LIVE" = "$SHA" ] || { echo "backend pid $NEW_PID runs from build '${LIVE:-unknown}', not $SHA" >&2; exit 1; }
echo "backend restarted: pid $NEW_PID on port $PORT from build $LIVE (probe HTTP $code)"

# The local end now runs <sha>; record it for the next deploy's migration
# gate. Recording here (not at staging) keeps the marker honest when a build
# is staged but never swapped.
git -C "$REPO" rev-parse "$SHA" > "$REPO/release/.last-deployed-sha"

if [ -z "$LOCAL_ONLY" ]; then
  # Let the new backend settle before remotes cycle.
  sleep 10
  "$DEPLOY_DIR/restart-remote-servers.sh"
else
  echo "local-only: remotes restart onto the new spec on their next reconnect"
fi

prune_builds
echo "deploy complete"
