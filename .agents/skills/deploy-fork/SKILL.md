---
name: deploy-fork
description: Deploy the fork's desktop build - land changes on the mine branch, build the "T3 Code (Fork)" DMG, and hand the user the swap-and-restart command. Use when the user wants to rebuild the fork binary, deploy or ship changes to their daily-driver app, update the fork build, or asks to "swap the binary".
---

# Deploy Fork

Get changes onto `mine`, build the desktop artifact, and hand over (not run)
the swap command. The running "T3 Code (Fork).app" owns the live `~/.t3`
userdata and may be hosting the very session doing the deploy — the human
performs the swap unless they explicitly ask the agent to do it.

## 1. Land changes on `mine`

`mine` is the daily-driver branch in the main checkout
(`~/Projects/t3code-fork`, where it is checked out — worktree branches cannot
fast-forward it from elsewhere; drive it with `git -C ~/Projects/t3code-fork`).

- Feature work on a worktree branch: merge it —
  `git -C ~/Projects/t3code-fork merge --ff-only <branch>` when `mine` hasn't
  moved, plain `merge --no-edit` when it has. Beware pipelines eating exit
  codes: `git merge … | tail` reports tail's status, so `&&` chains keep
  running after a failed merge.
- Loose edits in the main checkout: commit them directly there. The
  pre-existing modified `pnpm-lock.yaml` in that checkout is registry noise —
  leave it out of commits.
- Push `origin mine` after landing (the fork's remote is the backup).

## 2. Migration gate (the one-way door)

Before building, diff `apps/server/src/persistence/Migrations.ts` between the
previously deployed commit and the new tip:

```bash
git -C ~/Projects/t3code-fork log --oneline <last-built-sha>..mine -- apps/server/src/persistence/Migrations.ts
```

Any hit means the new build will migrate the live DB forward-only on first
launch. Snapshot first (safe while the app runs):

```bash
bun -e "new (require('bun:sqlite').Database)(process.env.HOME + '/.t3/userdata/state.sqlite', { readonly: true }).run(\"VACUUM INTO '\" + process.env.HOME + \"/t3code-backups/pre-deploy-$(date +%Y%m%d-%H%M)/state.sqlite'\")"
```

(Create the target directory first; `VACUUM INTO` refuses to overwrite.)

## 3. Build

From the main checkout, in the background (takes ~1–2 minutes):

```bash
node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64
```

Confirm success by the `Done. Artifacts:` log line and a FRESH mtime on
`release/T3-Code-<version>-arm64.dmg` — the file at that path is otherwise the
previous build, and handing over a swap command for a stale DMG deploys old
code. Read `<version>` from the artifact name; it also names the DMG volume.

## 4. Hand over the swap command

Give the user this to paste (adjust `<version>`, currently `0.0.33`). Do not
run it unprompted — quitting the app kills their live session:

```bash
osascript -e 'tell application "T3 Code (Fork)" to quit' && sleep 5 && hdiutil attach -nobrowse ~/Projects/t3code-fork/release/T3-Code-<version>-arm64.dmg && rm -rf "/Applications/T3 Code (Fork).app" && ditto "/Volumes/T3 Code (Fork) <version> Installer/T3 Code (Fork).app" "/Applications/T3 Code (Fork).app" && hdiutil detach "/Volumes/T3 Code (Fork) <version> Installer" && open -a "T3 Code (Fork)"
```

If the user asks the agent to perform the swap: quit via the osascript above
(never `pkill`/`kill` by pattern), poll until
`ps aux | grep "[T]3 Code (Fork).app/Contents/MacOS"` is empty, then
attach → `rm -rf` the old app → `ditto` → detach → `open -a`, and verify a
new PID exists.

## 5. After relaunch

- Tell the user to hit `Cmd+R` in the app window. The renderer loads via the
  `t3code://app` scheme whose Chromium cache (shared
  `~/Library/Application Support/t3code`, same URLs and version across
  builds) can serve the previous frontend for up to an hour after a swap —
  a symptom that looks exactly like "the fix didn't work".
- Never launch "T3 Code (Alpha)" to compare: it auto-updates and can migrate
  the shared live DB ahead of the fork's schema. The Electron single-instance
  lock prevents running both, which is a feature.
- The deployed sha is worth noting somewhere (commit message, reply) — step 2
  needs `<last-built-sha>` next time.
