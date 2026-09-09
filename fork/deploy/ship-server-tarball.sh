#!/bin/bash
# Ships the fork server tarball to every host in remote-hosts under a
# sha-versioned name (npx caches installs by spec string — reusing a path can
# serve a stale extraction), then points ~/.t3/fork/ssh-t3-package-spec at it.
# The spec is one global path, so every host must expose the tarball at the
# same absolute location (user must be `ubuntu`). The spec is read at server
# (re)launch, so the new bits apply when the swap script forces the restarts.
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
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" \
    "cd ~ && timeout 600 npm exec --yes --no-audit --no-fund --package /home/ubuntu/.t3/fork/t3-fork-$SHA.tgz -- t3 --version" >&2 \
    || echo "$host: pre-warm failed; the launcher will install on next connect" >&2
done

printf '# fork server tarball on the remote hosts (see fork/README.md)\n/home/ubuntu/.t3/fork/t3-fork-%s.tgz\n' "$SHA" > "$REMOTE_SPEC_FILE"
echo "spec updated: $(tail -1 "$REMOTE_SPEC_FILE")" >&2
