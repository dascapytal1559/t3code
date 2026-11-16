#!/bin/sh
# Session-start hook shared by Claude, Codex and Grok. It appends one line to T3's session register
# (docs/user/usage.md#count-agent-sessions-t3-does-not-run) naming the T3 thread or FirstMate task
# whose environment started the session. It prints nothing and always exits 0: a hook must never
# delay, block or fail a session.
#
# Usage: session-register-hook.sh <claude|codex|grok> <register folder>

provider=$1
folder=$2
# Grok also runs the hooks in Claude's settings, so a Claude install fires there too.
[ -n "$GROK_HOOK_EVENT" ] && provider=grok

# The text between a JSON string's quotes, still escaped, so it is copied into the line as is.
field() {
  printf '%s' "$payload" |
    sed -nE "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"(([^\"\\\\]|\\\\.)*)\".*/\\1/p" | head -n 1
}
escape() {
  printf '%s' "$1" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g'
}
member() {
  [ -n "$2" ] && printf ',"%s":"%s"' "$1" "$(escape "$2")"
}

{
  [ -n "$folder" ] || exit 0
  payload=
  [ -t 0 ] || payload=$(head -c 65536 | tr -d '\000-\037')
  session=$(field session_id)
  [ -n "$session" ] || session=$(field sessionId)
  [ -n "$session" ] || session=$(escape "$GROK_SESSION_ID")
  [ -n "$session" ] || exit 0
  cwd=$(field cwd)
  [ -n "$cwd" ] || cwd=$(escape "$PWD")
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  line="{\"v\":1,\"sessionId\":\"$session\",\"startedAt\":\"$now\",\"provider\":\"$(escape "${provider:-unknown}")\",\"cwd\":\"$cwd\"$(member threadId "$T3CODE_THREAD_ID")$(member fmTaskId "$FM_TASK_ID")$(member fmHome "$FM_HOME")}"
  mkdir -p "$folder" && printf '%s\n' "$line" >>"$folder/${now%-*T*}.jsonl"
} >/dev/null 2>&1
exit 0
