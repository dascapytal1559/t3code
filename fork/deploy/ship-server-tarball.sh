#!/bin/bash
# Ships the fork server tarball to every host in remote-hosts under a
# sha-versioned name (npx caches installs by spec string — reusing a path can
# serve a stale extraction) and pre-installs it into each host's npx cache.
# The pre-warm runs `t3 --version` from that install, which boots the server
# bundle and loads its external dependencies, so it doubles as the remote
# boot test: a host that fails it fails the ship. Nothing here changes what
# the remotes run; restart-remote-servers.sh (called by the swap scripts)
# points ~/.t3/fork/ssh-t3-package-spec at the shipped tarball and restarts.
#
# Usage: ship-server-tarball.sh <tarball-path>
set -euo pipefail
source "$(dirname "$0")/lib.sh"

TARBALL="${1:?usage: ship-server-tarball.sh <tarball-path>}"
SHA="$(head_sha)"

[ -f "$TARBALL" ] || { echo "missing tarball: $TARBALL" >&2; exit 1; }

for host in $(remote_hosts); do
  echo "shipping t3-fork-$SHA.tgz to $host" >&2
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" 'mkdir -p .t3/fork'
  scp -q "$TARBALL" "$host":.t3/fork/t3-fork-"$SHA".tgz
  # Pre-warm the npx install so the launcher's later `npm exec` starts the
  # server in seconds instead of installing cold. 2026-09-04: cold installs
  # from the launcher piled up behind one stalled npm process on both hosts
  # and neither server came back for 20 minutes.
  echo "installing t3-fork-$SHA.tgz into the npx cache on $host" >&2
  if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" \
    "cd ~ && timeout 600 npm exec --yes --no-audit --no-fund --package /home/ubuntu/.t3/fork/t3-fork-$SHA.tgz -- t3 --version" >&2; then
    # 2026-09-18: an unpatched dependency made the server crash on import;
    # this is the last check before a swap would restart the remotes onto it.
    echo "$host: t3-fork-$SHA.tgz does not boot there; not shipped" >&2
    exit 1
  fi
done
echo "shipped t3-fork-$SHA.tgz to $(remote_hosts | tr '\n' ' ')" >&2
