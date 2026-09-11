#!/bin/bash
# One-call picture of what is deployed where. Read-only; run it before a
# deploy (DEPLOY_FORK.md step 2) and after one (step 6). Every line is one
# source of truth: repo, markers, payload symlink, installed app, running
# backend, remote spec, swap in flight, last deploy-log run.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

short() { git -C "$REPO" rev-parse --short "$1" 2>/dev/null || printf '%s' "${1:-none}"; }
behind() { git -C "$REPO" rev-list --count "$1..HEAD" 2>/dev/null || printf '?'; }

head="$(git -C "$REPO" rev-parse HEAD)"
dirty=""; [ -z "$(git -C "$REPO" status --porcelain)" ] || dirty=" (working tree dirty)"
deployed="$(read_sha_file "$LAST_DEPLOYED_SHA_FILE" || true)"
dmg="$(read_sha_file "$LAST_DMG_SHA_FILE" || true)"
printf 'repo         HEAD %s on %s%s\n' "$(short HEAD)" "$(git -C "$REPO" branch --show-current)" "$dirty"
printf 'markers      last-deployed %s, last-dmg %s\n' "$(short "${deployed:-none}")" "$(short "${dmg:-none}")"
if [ -n "$deployed" ] && [ "$deployed" != "$head" ]; then
  printf '             HEAD is %s commits past the deployed marker\n' "$(behind "$deployed")"
fi
printf 'next path    %s\n' "$(decide_deploy_path)"

current="$(readlink "$CURRENT_LINK" 2>/dev/null || printf none)"
staged="$(ls "$BUILDS_DIR" 2>/dev/null | tr '\n' ' ')"
printf 'payload      current -> %s; staged: %s\n' "$current" "${staged:-none}"
if [ -n "$deployed" ] && [ "$current" != "builds/$(short "$deployed")" ]; then
  printf '             symlink and last-deployed marker disagree: a swap was interrupted\n'
fi

app_ver="$(defaults read "$APP/Contents/Info" CFBundleShortVersionString 2>/dev/null || printf '?')"
app_mtime="$(stat -f '%Sm' "$APP_BINARY" 2>/dev/null || printf missing)"
if app_running; then app_state=running; else app_state="not running"; fi
printf 'app          %s, binary %s, %s\n' "$app_ver" "$app_mtime" "$app_state"

pid="$(backend_pid || true)"
if [ -n "$pid" ]; then
  printf 'backend      pid %s from build %s, port %s\n' "$pid" "$(live_build "$pid" || printf '?')" "$(listen_port "$pid" || printf '?')"
else
  printf 'backend      none from %s (app down, or running the bundled server)\n' "$CURRENT_LINK"
fi

spec="$(grep -v '^[[:space:]]*#' "$REMOTE_SPEC_FILE" 2>/dev/null | grep -v '^[[:space:]]*$' | awk 'NR == 1' || true)"
spec_sha="$(printf '%s' "$spec" | sed -nE 's/.*t3-fork-([0-9a-f]+)\.tgz.*/\1/p')"
if [ -n "$spec" ]; then
  printf 'remote spec  %s' "${spec##*/}"
  if [ -n "$spec_sha" ] && git -C "$REPO" rev-parse --verify "$spec_sha^0" >/dev/null 2>&1; then
    printf ' (%s commits behind HEAD)' "$(behind "$spec_sha")"
  fi
  printf '\n'
else
  printf 'remote spec  none (remotes use the channel package)\n'
fi

# Anchored on the interpreter so an agent shell whose command text merely
# mentions the script names does not count as a deploy in flight.
procs="$(ps -axo pid,command)"
swap="$(grep -E '^ *[0-9]+ +(/bin/)?bash +[^ ]*swap-fork-(app|payload)\.sh' <<<"$procs" | awk 'NR == 1 { print $1 }' || true)"
[ -z "$swap" ] || printf 'in flight    swap script pid %s\n' "$swap"

if [ -f "$DEPLOY_LOG" ]; then
  printf 'deploy log   last run:\n'
  awk '/=== /{ buf = "" } { buf = buf $0 "\n" } END { printf "%s", buf }' "$DEPLOY_LOG" | tail -n 8 | sed 's/^/             /'
else
  printf 'deploy log   none yet\n'
fi
