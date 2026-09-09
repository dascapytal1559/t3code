# Deploy Fork

Runbook for putting a fork build everywhere the user runs it: land the change,
build the server tarball (and the DMG only when choose-deploy-path.sh prints dmg),
stage the local payload, ship the tarball to the remote hosts, and — only on
an explicit deploy instruction — swap local and remote via a self-detaching
script. Applies whenever the user asks to deploy, ship, rebuild, or swap the
fork build.

The forked repo lives at `~/Projects/t3code-fork`. Its `fork/` directory
holds this runbook, the `fork/deploy/` scripts, and the maintained fork
feature record, `fork/README.md`. All git and build commands below run
against the repo root.

A deploy covers **both ends**: the local desktop app and the fork server on
each remote host listed in `~/Projects/t3code-fork/fork/deploy/remote-hosts`.
The user wants all of them on the same commit so server-side behavior (file
explorer, skills) matches everywhere. Never ship one end without the others.

The local end runs its backend from `~/.t3/fork/current`, a symlink into
`~/.t3/fork/builds/<sha>/` (fork feature: desktop server payload override).
The app's backend supervisor respawns the backend from that path whenever it
exits, so a **payload deploy retargets the symlink and restarts the backend in
place — the app never quits**, and the window shows the new frontend on its
next reload (Cmd+R). A DMG deploy still quits and relaunches the app.

## Deployment gate — explicit instruction only

Building artifacts and staging payloads may happen whenever useful. The
**swap** (step 5) runs ONLY when the user's current message explicitly
instructs deployment — "deploy", "ship it", "swap the binary", "update the
fork build", or equivalent. Do not infer it from a bug being fixed, a build
finishing, a past conversation, or memory. Without that instruction, stop
after step 4 and report that the build is staged and ready to deploy.

## 1. Land changes on `<branch>`

`<branch>` is the daily-driver branch checked out at
`~/Projects/t3code-fork` (resolve with
`git -C ~/Projects/t3code-fork branch --show-current`; worktree
branches cannot fast-forward it from elsewhere — drive it with
`git -C ~/Projects/t3code-fork`).

- Behavior changes land WITH their `fork/README.md` entry — that file is the
  canonical record of what this fork does, and a deployed change that is not
  in it is invisible to the next agent. Add or update the entry in the same
  commit as the change.
- Feature work on a worktree branch: merge it — `merge --ff-only` when
  `<branch>` hasn't moved, plain `merge --no-edit` when it has. Beware
  pipelines eating exit codes: `git merge … | tail` reports tail's status.
- Loose edits in the main checkout: commit them directly there. Stage only
  the files belonging to the change — the checkout often carries unrelated
  in-progress work.
- Push `origin <branch>` after landing (the fork's remote is the backup).

## 2. Migration gate (the one-way door)

This gate applies to BOTH deploy paths — a restarted backend migrates
databases exactly like a relaunched app. Before building, diff
`apps/server/src/persistence/Migrations.ts` between the previously deployed
commit and the new tip. Read `<last-deployed-sha>` from
`~/Projects/t3code-fork/release/.last-deployed-sha` (written by the
swap scripts on a successful swap, so a staged-but-never-swapped build does
not move it). If missing, derive it from the live payload:
`readlink ~/.t3/fork/current` names `builds/<sha>`.

```bash
git -C ~/Projects/t3code-fork log --oneline <last-deployed-sha>..<branch> -- apps/server/src/persistence/Migrations.ts
```

Any hit means the new build migrates DBs forward-only on first launch — the
local live DB **and** the DB on every host in `fork/deploy/remote-hosts`.
Snapshot all of them first (safe while servers run; create target
directories first, `VACUUM INTO` refuses to overwrite; repeat the ssh
command per host):

```bash
bun -e "new (require('bun:sqlite').Database)(process.env.HOME + '/.t3/userdata/state.sqlite', { readonly: true }).run(\"VACUUM INTO '\" + process.env.HOME + \"/t3code-backups/pre-deploy-$(date +%Y%m%d-%H%M)/state.sqlite'\")"
ssh basedcapital-zdata 'mkdir -p ~/t3-backups/pre-deploy-$(date +%Y%m%d-%H%M) && node -e "const{DatabaseSync}=require(\"node:sqlite\");const os=require(\"os\");new DatabaseSync(os.homedir()+\"/.t3/userdata/state.sqlite\",{readOnly:true}).exec(\"VACUUM INTO \x27\"+os.homedir()+\"/t3-backups/pre-deploy-$(date +%Y%m%d-%H%M)/state.sqlite\x27\")"'
```

## 3. Choose the deploy path

**Payload is the default.** Do not invent a glob and do not DMG because
something under `apps/desktop/` appeared in `git log` since the last DMG.
Run the helper and do what it prints:

```bash
~/Projects/t3code-fork/fork/deploy/choose-deploy-path.sh
# last stdout line is "payload" or "dmg"; notes go to stderr
```

- **Payload:** server, web, mobile, contracts, client-runtime, docs, desktop
  _tests_, or a `test(…)` commit that only moved already-shipped override
  readers. `swap-fork-payload.sh` retargets the symlink and restarts the
  backend; the app window stays up. Cmd+R loads the new frontend.
- **DMG:** a non-test commit since the last _payload_ swap changed code the
  Electron process itself runs — `apps/desktop/src/` (not `*.test.ts` /
  `*.fork.test.ts`), `native/`, `patches/`, Electron or electron-builder
  bumps, `scripts/build-desktop-artifact.ts`, or signing/identity. Also when
  `swap-fork-payload.sh` refuses with "no backend running from
  ~/.t3/fork/current" (installed app predates the symlink override).

**When in doubt, payload.** A missed DMG leaves the Electron binary a commit
behind until the next real shell change; a mistaken DMG quits the app and
every hosted session, including the one following this runbook.

The helper looks at last-deployed-sha..HEAD (not last-dmg-sha), skips
commits whose subject starts with `test(` or `test:`, and ignores test
files. Unreleased desktop-test commits since the last DMG are printed as a
note; they do not upgrade the path. The swap scripts refuse a mismatched
path unless you pass `--force`.

## 4. Build and stage

All paths need the server tarball; only the DMG path builds the DMG. Each
takes ~1–2 minutes; run in the background. Build scripts need node on PATH
(`~/.vite-plus/bin`) and the DMG additionally needs cargo (`~/.cargo/bin`).

```bash
~/Projects/t3code-fork/fork/deploy/pack-server-tarball.sh   # prints the tarball path
# DMG path only:
node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64
```

The tarball is built from the working tree, so uncommitted work rides along.
When the main checkout carries work that must not ship, build from a clean
worktree of the commit instead: `git worktree add --detach /tmp/t3-clean
<sha>`, `vp install --frozen-lockfile` there, then run the pack, stage and
ship scripts with `T3_FORK_REPO=/tmp/t3-clean` exported (`lib.sh` honors
it). Remove the worktree afterwards.

For the DMG, confirm the `Done. Artifacts:` log line and a FRESH mtime on
`release/T3-Code-<version>-arm64.dmg` — a stale file at that path deploys
old code. Read `<version>` from the artifact name.

**Stage the local payload** (both paths — the DMG path's relaunched app runs
it too, and it keeps local and remote on the same artifact). Staging is
inert: it extracts into `~/.t3/fork/builds/<sha>/` and does not touch the
symlink, so nothing runs the new code until step 5. It refuses to restage the
sha the symlink currently names. Every other build is pruned at the end of
the next successful swap, so the directory holds at most the live build and
the staged one.

```bash
~/Projects/t3code-fork/fork/deploy/stage-server-payload.sh <tarball-path>  # prints the payload dir
```

**Ship the tarball to remote hosts** and point the spec override at it:

```bash
~/Projects/t3code-fork/fork/deploy/ship-server-tarball.sh <tarball-path>
```

The spec is read on every remote (re)launch, so the new bits apply when step
5 forces the restarts. Shipping also pre-installs the tarball into each
host's npx cache, so the relaunch starts the server in seconds; without it,
cold launcher installs have piled up behind one stalled npm process and left
both hosts down for 20 minutes. The swap scripts record the deployed sha on
success — nothing to record here.

## 5. Autonomous swap

Gate check first (see above). Both scripts kill every session hosted by the
local backend — **including the agent session following this runbook** — so
they detach themselves into their own process session on start and return
immediately; the caller's shell can die without harm. Run them directly:

```bash
# Payload deploy — backend restarts in place, app stays up (default):
~/Projects/t3code-fork/fork/deploy/swap-fork-payload.sh
# DMG deploy — app quits, /Applications swap, relaunch (only if the helper printed dmg):
~/Projects/t3code-fork/fork/deploy/swap-fork-app.sh
```

Both default to HEAD: the payload script takes an optional `<sha>`, the DMG
script an optional `<version>` (default: `apps/desktop/package.json`).
`swap-fork-payload.sh` also takes `--local-only` to skip the forced remote
restart; remotes then converge on their next reconnect via the runner shim's
embedded package spec.

Each script validates its inputs, detaches, sleeps 8 seconds (a head start to
finish the current turn), then acts. `swap-fork-payload.sh` retargets
`~/.t3/fork/current`, terminates the backend pid (SIGKILL after 10s), waits
for the supervisor's replacement to appear with a different pid, answer HTTP
on its listening port, and be mapped (per lsof) from the new build, and
aborts before touching remotes if any of that fails. `swap-fork-app.sh`
refuses a DMG older than the HEAD commit, quits the app (up to 60s — draining
sessions and tunnels takes ~35s), swaps `/Applications/T3 Code (Alpha).app`
from the DMG, ad-hoc signs the copied bundle (the unsigned build has no
resource seal, so Gatekeeper's re-assessment fails and Launch Services never
resumes the process `open` spawns), retargets the symlink, opens the app,
and verifies a backend runs from the symlink. If no app process appears
within 15s it says so and keeps waiting up to 10 minutes for the user to open
the app by hand, then carries on. Both then run
`fork/deploy/restart-remote-servers.sh`, which kills only the PID owning each
recorded ssh-launch port after confirming its cmdline is a `t3 serve`
process, waits for the app to auto-restart it from the new tarball spec, and
prunes the host's other fork npx installs and tarballs. Finally they prune
local builds. All progress goes to `~/.t3/fork/deploy.log`, which ends in
`deploy complete` on success and holds the error otherwise.

**Make the swap call the last tool call of the turn**, then immediately send
a short wrap-up telling the user the deploy is running and to hit `Cmd+R`
once the backend (payload) or the app (DMG) is back. Do not run anything
after it — the turn dies with the backend.

## 6. After the swap (next turn)

- `tail ~/.t3/fork/deploy.log` must end in `deploy complete`; otherwise it
  shows where the script stopped.
- `readlink ~/.t3/fork/current` names `builds/<sha>` for the deployed sha.
- The backend runs from the symlink: `ps -axo command | grep "[b]in.mjs"`
  shows the `~/.t3/fork/current/apps/server/dist/bin.mjs` entry path. Use
  ps, not pgrep: macOS pgrep cannot read the hardened-runtime app processes'
  argv and matches nothing even while they run. A bundled `app.asar` path
  instead means the app fell back to the bundled server — inspect the symlink
  and the payload layout.
- Deployed builds serve `index.html` with `no-cache` (fork feature:
  `staticResponseCacheControl`), so the new frontend loads on the next
  natural reload; a `Cmd+R` costs nothing when in doubt.
- DMG deploy: verify the installed binary's mtime is within the DMG build's
  window or later —
  `stat -f '%Sm' "/Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)"`.
- If a host reports "server not back after 60s", look for stacked
  `npm exec` processes on it (`ps -eo pid,etime,args | awk '$2=="npm"'`).
  2026-09-04: npm's audit request hung indefinitely on both hosts, every
  launcher attempt stacked behind it, and the launcher's install check timed
  out with "npm produced no t3 executable". Each host now carries
  `audit=false` / `fund=false` in `~/.npmrc`; a new host needs the same.
  Kill stacked processes by their exact PIDs — never by pattern, and never
  from a shell whose own command line contains the pattern — and the app's
  next launch attempt (every couple of minutes while the environment is
  open) comes up.
- Verify each remote host runs the new build: the `t3 serve` process argv
  shows an npx cache path or `npm exec`; the `~/.npm/_npx/<hash>/package.json`
  containing the deployed `t3-fork-<sha>.tgz` spec must correspond to the
  running process. A `managed` value of `external` in
  `~/.t3/ssh-launch/<key>/managed` means the launcher adopted a pre-existing
  server and will never replace it — stop it by port-verified PID (as in
  `restart-remote-servers.sh`) and let the app relaunch it.
- Builds and remote npx installs are pruned by the swap scripts; nothing to
  clean by hand. If a swap aborted early, the next successful one prunes.
- The fork intentionally uses the stock `T3 Code (Alpha)` app identity. Do
  not install a separate upstream build over the daily-driver app when its
  schema may be ahead of the fork.

## Manual fallback

If the user prefers to run the swap themselves, hand over — do not run — the
appropriate command, then apply step 5's remote restart afterwards. Payload
deploy (find the pid with `ps -axo pid,command | grep "[b]in.mjs"`):

```bash
ln -sfh builds/<sha> ~/.t3/fork/current && kill <backend-pid>
```

DMG deploy:

```bash
osascript -e 'tell application "T3 Code (Alpha)" to quit' && sleep 40 && hdiutil attach -nobrowse ~/Projects/t3code-fork/release/T3-Code-<version>-arm64.dmg && rm -rf "/Applications/T3 Code (Alpha).app" && ditto "/Volumes/T3 Code (Alpha) <version> Installer/T3 Code (Alpha).app" "/Applications/T3 Code (Alpha).app" && hdiutil detach "/Volumes/T3 Code (Alpha) <version> Installer" && codesign --force --deep --sign - "/Applications/T3 Code (Alpha).app" && ln -sfh builds/<sha> ~/.t3/fork/current && open "/Applications/T3 Code (Alpha).app"
```
