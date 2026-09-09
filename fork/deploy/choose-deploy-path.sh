#!/bin/bash
# Prints payload or dmg as the last stdout line. Notes and triggering files
# go to stderr. Payload is the default; see decide_deploy_path in lib.sh.
#
# Usage: choose-deploy-path.sh
set -euo pipefail
source "$(dirname "$0")/lib.sh"

FROM="$(read_sha_file "$LAST_DEPLOYED_SHA_FILE" || true)"
LAST_DMG="$(read_sha_file "$LAST_DMG_SHA_FILE" || true)"
if [ -z "$FROM" ]; then
  FROM="$LAST_DMG"
fi

PATH_KIND="$(decide_deploy_path)"
{
  echo "deploy path: $PATH_KIND"
  echo "HEAD: $(git -C "$REPO" rev-parse --short HEAD)"
  echo "last payload swap: ${FROM:-none}"
  echo "last DMG swap: ${LAST_DMG:-none}"
  echo
  if [ -n "$FROM" ]; then
    echo "desktop-shell runtime files in non-test commits since last payload swap:"
    files="$(desktop_shell_files_since "$FROM" HEAD || true)"
    if [ -n "$files" ]; then
      printf '%s\n' "$files"
    else
      echo "(none — payload is enough)"
    fi
  else
    echo "no last-deployed sha; defaulting to $PATH_KIND"
  fi
  if [ -n "$LAST_DMG" ] && [ "$LAST_DMG" != "$FROM" ]; then
    echo
    echo "unreleased since last DMG (does not force a DMG on a payload deploy):"
    pathspec=()
    while IFS= read -r line; do
      [ -n "$line" ] && pathspec+=("$line")
    done < <(desktop_shell_git_pathspec)
    pending="$(git -C "$REPO" log --oneline "$LAST_DMG"..HEAD -- "${pathspec[@]}" || true)"
    if [ -n "$pending" ]; then
      printf '%s\n' "$pending"
    else
      echo "(none)"
    fi
  fi
} >&2

printf '%s\n' "$PATH_KIND"
