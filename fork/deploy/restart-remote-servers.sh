#!/bin/bash
# Moves the remote hosts onto the shipped tarball for <sha>: points
# ~/.t3/fork/ssh-t3-package-spec at it, restarts the launcher-managed t3
# server on each host in remote-hosts so the next launch reads that spec,
# then prunes each host's stale npx installs and tarballs. Kills only the PID
# that owns the recorded ssh-launch port and whose cmdline is a t3 serve
# process (never kill by name pattern). Expects the desktop app to be
# running: it re-ensures any environment it has open and starts a server
# from the current runner spec. An environment that is not open in the app
# stays down until it is next opened — a host that does not come back is a
# note, not a failure. The swap scripts run this; run it by hand with the
# deployed sha to clear a --local-only skew.
#
# Usage: restart-remote-servers.sh <sha>
set -euo pipefail
source "$(dirname "$0")/lib.sh"

SHA="${1:?usage: restart-remote-servers.sh <sha>}"
TARBALL_NAME="t3-fork-$SHA.tgz"
TARBALL_PATH="/home/ubuntu/.t3/fork/$TARBALL_NAME"

# The spec is one global path, so it may only move once every host has the
# tarball (ship-server-tarball.sh). Checked before anything is stopped.
for host in $(remote_hosts); do
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" "test -f $TARBALL_PATH" \
    || { echo "$host does not have $TARBALL_NAME; ship it first" >&2; exit 1; }
done
printf '# fork server tarball on the remote hosts (see fork/README.md)\n%s\n' "$TARBALL_PATH" > "$REMOTE_SPEC_FILE"
echo "remote spec -> $TARBALL_PATH"

for host in $(remote_hosts); do
  echo "restarting t3 server on $host..."
  stopped="$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" sh -s <<'REMOTE' || echo "ssh to $host failed"
for pf in .t3/ssh-launch/*/port; do
  [ -f "$pf" ] || continue
  port=$(cat "$pf")
  pid=$(ss -H -ltnp "sport = :$port" 2>/dev/null | sed -n "s/.*pid=\([0-9]*\).*/\1/p" | head -1)
  [ -n "$pid" ] || { echo "no listener on port $port"; continue; }
  if tr "\0" " " < "/proc/$pid/cmdline" | grep -q "t3 [s]erve"; then
    kill "$pid" && echo "stopped pid $pid (port $port)"
  else
    echo "port $port owner pid $pid is not a t3 serve process; leaving it"
  fi
done
REMOTE
)"
  echo "$stopped"
  case "$stopped" in
    *stopped\ pid*)
      started=""
      for _ in $(seq 1 6); do
        sleep 10
        started="$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" \
          'ps -eo args | grep "[t]3 serve" | head -1' || true)"
        [ -n "$started" ] && break
      done
      if [ -n "$started" ]; then
        echo "$host server restarted: $started"
      else
        echo "$host: server not back after 60s; it will start from the new spec when the environment is next opened"
      fi
      ;;
    *)
      echo "$host: nothing to stop; server starts from the new spec on next connect"
      ;;
  esac

  # npx keeps one full install per spec string; drop every fork install and
  # tarball other than the current spec's, skipping any a running process
  # still references.
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" sh -s -- "$TARBALL_NAME" <<'REMOTE' || echo "$host: prune skipped (ssh failed)"
keep="$1"
for dir in "$HOME"/.npm/_npx/*/; do
  spec=$(grep -o "t3-fork-[0-9a-f]*\.tgz" "$dir/package.json" 2>/dev/null | head -1)
  [ -n "$spec" ] && [ "$spec" != "$keep" ] || continue
  if ps -eo args | grep -v grep | grep -qF "$dir"; then continue; fi
  rm -rf "$dir" && echo "pruned npx install of $spec"
done
for f in "$HOME"/.t3/fork/t3-fork-*.tgz; do
  [ -f "$f" ] || continue
  [ "${f##*/}" = "$keep" ] || { rm -f "$f" && echo "pruned ${f##*/}"; }
done
REMOTE
done
