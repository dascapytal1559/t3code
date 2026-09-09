#!/bin/bash
# Shared helpers for the deploy scripts. Source it; do not execute it.

export PATH="$HOME/.vite-plus/bin:$HOME/.cargo/bin:$PATH"

FORK_DIR="$HOME/.t3/fork"
BUILDS_DIR="$FORK_DIR/builds"
CURRENT_LINK="$FORK_DIR/current"
DEPLOY_LOG="$FORK_DIR/deploy.log"
REMOTE_SPEC_FILE="$FORK_DIR/ssh-t3-package-spec"
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"   # <repo>/fork/deploy
# T3_FORK_REPO points the build at another checkout of the fork (a clean git
# worktree of the commit being shipped) when the main checkout carries
# uncommitted work that must not ride along in the tarball.
REPO="${T3_FORK_REPO:-$(cd "$DEPLOY_DIR/../.." && pwd)}"
REMOTE_HOSTS_FILE="$DEPLOY_DIR/remote-hosts"
APP="/Applications/T3 Code (Alpha).app"
APP_BINARY="$APP/Contents/MacOS/T3 Code (Alpha)"
APP_PROC_PATTERN='T3 Code \(Alpha\)\.app/Contents/MacOS'
BACKEND_ENTRY="$CURRENT_LINK/apps/server/dist/bin.mjs"

head_sha() { git -C "$REPO" rev-parse --short HEAD; }
remote_hosts() { grep -v '^[[:space:]]*#' "$REMOTE_HOSTS_FILE" | grep -v '^[[:space:]]*$' || true; }

LAST_DEPLOYED_SHA_FILE="$REPO/release/.last-deployed-sha"
LAST_DMG_SHA_FILE="$REPO/release/.last-dmg-sha"

# Files whose contents are compiled into the Electron binary. Tests and
# markdown next to them do not change the running app.
desktop_shell_git_pathspec() {
  printf '%s\n' \
    apps/desktop \
    native \
    patches \
    scripts/build-desktop-artifact.ts \
    ':(exclude,glob)**/*.test.ts' \
    ':(exclude,glob)**/*.fork.test.ts' \
    ':(exclude,glob)**/*.md'
}

# test(…) / test: commits are coverage and testability extracts. They may
# touch main.ts while moving already-shipped override readers; they do not
# by themselves mean the Electron binary must be replaced.
is_test_commit_subject() {
  case "$1" in
    test\(* | test:*) return 0 ;;
    *) return 1 ;;
  esac
}

read_sha_file() {
  local file="$1" sha=""
  [ -f "$file" ] || return 1
  sha="$(tr -d '[:space:]' <"$file")"
  [ -n "$sha" ] || return 1
  git -C "$REPO" rev-parse --verify "$sha^0" >/dev/null 2>&1 || return 1
  printf '%s\n' "$sha"
}

# Commits in ($from..$to] whose subject is not a test commit, listing
# desktop-shell runtime files they changed. Empty means payload is enough.
desktop_shell_files_since() {
  local from="$1" to="${2:-HEAD}" sha subject
  local -a pathspec=()
  [ -n "$from" ] || return 0
  git -C "$REPO" merge-base --is-ancestor "$from" "$to" 2>/dev/null || return 0
  while IFS= read -r line; do
    [ -n "$line" ] && pathspec+=("$line")
  done < <(desktop_shell_git_pathspec)
  while read -r sha subject; do
    [ -n "$sha" ] || continue
    is_test_commit_subject "$subject" && continue
    git -C "$REPO" diff-tree --no-commit-id --name-only -r "$sha" -- "${pathspec[@]}"
  done < <(git -C "$REPO" log --reverse --format='%H %s' "$from..$to") | sort -u
}

# Prints "payload" or "dmg". Payload is the default: the installed app already
# runs server+web from ~/.t3/fork/current. DMG only when a non-test commit
# since the last *payload* swap changed Electron/native/packaging runtime files.
# A pending test-commit extract since the last DMG is noted, not a reason to
# quit the app. When in doubt, payload.
decide_deploy_path() {
  local from files
  from="$(read_sha_file "$LAST_DEPLOYED_SHA_FILE" || true)"
  if [ -z "$from" ]; then
    from="$(read_sha_file "$LAST_DMG_SHA_FILE" || true)"
  fi
  files="$(desktop_shell_files_since "$from" HEAD || true)"
  if [ -n "$files" ]; then
    printf '%s\n' dmg
  else
    printf '%s\n' payload
  fi
}

# macOS pgrep -f cannot read the argv of the hardened-runtime app processes
# (it matches nothing even while they run), so process checks go through ps.
app_running() { ps -axo command | grep -v grep | grep -Eq "$APP_PROC_PATTERN"; }

# PID of the desktop's primary backend child, identified by the symlink entry
# path in its argv. Empty when nothing runs from ~/.t3/fork/current: the app
# is down, or it is an older build that reads the bundled tree.
backend_pid() {
  ps -axo pid,command | grep -v grep | grep -F "$BACKEND_ENTRY --bootstrap-fd" \
    | awk '{print $1}' | head -1
}

# The TCP port pid listens on, or empty while it has not bound yet.
listen_port() {
  lsof -a -nP -p "$1" -iTCP -sTCP:LISTEN 2>/dev/null \
    | awk 'NR > 1 { sub(/.*:/, "", $9); print $9; exit }'
}

# Name of the build directory the backend pid really runs from. Node resolved
# the symlink at spawn, and the payload's native addons stay mapped from that
# directory, so lsof reports it even after the symlink moved on.
live_build() {
  lsof -p "$1" 2>/dev/null \
    | awk -v prefix="$BUILDS_DIR/" '$4 == "txt" && index($NF, prefix) == 1 { print $NF; exit }' \
    | sed -E 's|.*/builds/([^/]+)/.*|\1|'
}

# Points ~/.t3/fork/current at builds/<sha>. -h replaces the symlink itself
# instead of descending into the directory it targets.
retarget_current() {
  local sha="$1"
  [ -f "$BUILDS_DIR/$sha/apps/server/dist/bin.mjs" ] \
    || { echo "missing payload: $BUILDS_DIR/$sha" >&2; return 1; }
  ln -sfh "builds/$sha" "$CURRENT_LINK"
  echo "current -> $(readlink "$CURRENT_LINK")"
}

# Deletes every staged build except the symlink target and the one the
# running backend is mapped from (the same build after a successful swap).
prune_builds() {
  local keep_current keep_live pid dir name
  keep_current="$(readlink "$CURRENT_LINK" 2>/dev/null || true)"
  keep_current="${keep_current##*/}"
  pid="$(backend_pid || true)"
  keep_live=""
  [ -n "$pid" ] && keep_live="$(live_build "$pid" || true)"
  for dir in "$BUILDS_DIR"/*/; do
    name="$(basename "$dir")"
    case "$name" in "$keep_current" | "$keep_live") continue ;; esac
    rm -rf "$dir" && echo "pruned build $name"
  done
  echo "kept builds: ${keep_current:-none} (current), ${keep_live:-none} (live)"
}

# Re-executes the calling script detached — its own session, stdio on the
# deploy log — and exits the caller. Deploys terminate the backend (or the
# whole app), which kills every session it hosts including the agent running
# the script; only a detached process outlives that. Callers read $DEPLOY_LOG
# afterwards: it ends in "deploy complete" on success and holds the error
# otherwise.
detach_self() {
  if [ "${T3_FORK_DEPLOY_DETACHED:-}" = 1 ]; then return 0; fi
  T3_FORK_DEPLOY_DETACHED=1 nohup perl -MPOSIX \
    -e 'POSIX::setsid() or die "setsid: $!"; exec @ARGV or die "exec: $!"' -- "$0" "$@" \
    >"$DEPLOY_LOG" 2>&1 </dev/null &
  echo "deploy detached (pid $!); progress in $DEPLOY_LOG"
  exit 0
}
