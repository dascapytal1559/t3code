# Fork feature delta

This is the canonical record of behavior this fork adds on top of upstream
T3 Code. Update it when a feature's behavior changes, not merely when syncing.
The fork now uses the stock **T3 Code (Alpha)** desktop identity; the differences
below are product behavior, not parallel-app branding.

## Grok skill discovery

Upstream's Grok provider publishes no skills. The fork asks the Grok CLI via
`grok inspect --json` and surfaces its user-invocable skills like any other
provider's inventory.

Implementation: `apps/server/src/provider/Drivers/GrokSkills.ts`.

## Workspace-aware skills

Skill inventories are resolved per project. The server queries the selected
provider instance with the active project's directory as its working directory
instead of reusing one server-wide snapshot probed at startup. Projects with
different repo-local or nested skill sets therefore see their own inventory in
the `$` and `/` menus.

Implementation: provider skill drivers under
`apps/server/src/provider/Drivers/` and their provider layers.

## Symlink-aware explorer and search

The native workspace scanner (`@ff-labs/fff-node`) does not traverse symlinks.
The fork supplements it with a cycle-safe, bounded walk that enumerates
root-level symlinks and follows symlinked directories, including targets outside
the workspace. Supplemental entries merge into both the file tree and path
search and obey the project's VCS ignores. The walk is capped at 5,000 entries
and rebuilt when the workspace index refreshes. Search reports truncation when
unique supplemental results exceed the requested limit.

Entries that are themselves symbolic links carry an optional `symlink` flag on
the `ProjectEntry` contract (omitted for regular entries; `kind` still reflects
the resolved target). The file explorer renders a small muted ↗ badge on those
rows — web/desktop through the tree's row-decoration hook, mobile next to the
row name. Descendants reached through a link are not flagged, and on web a
symlinked directory absorbed into a flattened single-child segment shows no
badge.

Implementation: `apps/server/src/workspace/WorkspaceSearchIndex.ts`,
`packages/contracts/src/project.ts`,
`apps/web/src/components/files/FileBrowserPanel.tsx`, and
`apps/mobile/src/features/files/FileTreeBrowser.tsx`.

## Hidden-root visibility

The same supplemental walk exposes root-level dotfiles and dot-directories that
the native index omits. `.git`, `.DS_Store`, and upstream's `.convex` cache
exclusion remain hidden, as do paths ignored by the active VCS.

Implementation: `apps/server/src/workspace/WorkspaceSearchIndex.ts`.

## Live filesystem updates

While a client subscribes to workspace changes, the server watches the active
workspace and pushes invalidations for changes made outside T3. The watcher is
shared by subscribers to the same resolved workspace and is released after the
last subscriber disconnects. Because `@parcel/watcher` does not follow directory
symlinks, the fork also watches discovered external symlink targets. It does not
blanket-ignore `node_modules`, because those entries can be visible in the
explorer when the project's VCS rules allow them.

Because the watcher can miss changes (unwatchable filesystems, failed
subscriptions), a manual explorer refresh — the web refresh button and mobile
pull-to-refresh — calls `projects.refreshEntries`, which rescans the workspace
index from disk and then emits a change event so every subscribed client
refetches, instead of merely re-reading the possibly stale index.

Implementation: `apps/server/src/workspace/WorkspaceWatcher.ts`, with client
query invalidation in the web and mobile `state/queries.ts` modules.

## Tilde paths stay plain in chat

Inline-code mentions beginning with `~/` stay plain code rather than being
expanded against a home directory guessed from the thread workspace. This
avoids fabricating local links for paths mentioned on remote machines. Absolute
and relative path chips, explicit Markdown links, and image embeds are
unchanged.

Implementation: `apps/web/src/markdown-links.ts`.

## Desktop runs a swappable server payload

When `~/.t3/fork/desktop-server-root` exists on the desktop machine, its first
non-empty, non-comment line names a directory that replaces the bundled server
tree in packaged builds. The directory must contain `apps/server/dist/bin.mjs`
(with `dist/client` inside) and a `node_modules` resolvable from its root —
the same shape as the app.asar server root. Because the web client is served
by the backend, one payload swap updates both server and frontend; only
desktop shell changes (Electron main process, natives, packaging) still need a
DMG rebuild. The file is read once at launch, `~/` expands to the home
directory, and a missing or invalid target falls back to the bundled tree, so
a stale pointer can never brick the app. Development launches ignore the file.

The payload is staged from the same npm tarball the remote hosts install
(`deploy/stage-server-payload.sh` in the wrapper repository extracts it and
runs `npm install`), so local and remote deploys share one artifact. Whether
the override took effect is observable in the backend child process's argv,
which contains the resolved entry path.

Implementation: `apps/desktop/src/main.ts` and
`apps/desktop/src/app/DesktopEnvironment.ts`.

## SSH launch runs the fork server

When `~/.t3/fork/ssh-t3-package-spec` exists on the desktop machine, its first
non-empty, non-comment line is used as the npm package spec for the remote T3
runner. An explicit override is authoritative even when a global `t3` binary is
already installed remotely. Remove the file to restore upstream's normal
channel-derived package selection and global-binary preference.

Deploys are covered by `.agents/skills/DEPLOY_FORK.md` in the wrapper repository.
`deploy/pack-server-tarball.sh` builds a SHA-versioned package for the remote
host, and `deploy/swap-fork-app.sh` replaces the stock-named desktop app.

Implementation: `packages/ssh/src/command.ts`, `packages/ssh/src/tunnel.ts`, and
`apps/desktop/src/main.ts`.

## Claude session recovery after latched auth errors

The Claude CLI latches into a logged-out state for its whole process lifetime
when its OAuth refresh fails (typically because a concurrent Claude process
rotated the shared credentials first): every later turn short-circuits to
"Not logged in · Please run /login" even after credentials are valid again.
Upstream keeps that process alive across turns, stranding the one thread while
new threads work. The fork detects auth-error results, posts a runtime warning
to the thread, and closes the runtime so the normal teardown path emits
`session.exited`; the next message respawns the CLI, which reads the current
credentials and resumes from the persisted cursor.

Implementation: `apps/server/src/provider/Layers/ClaudeAdapter.ts`
(`isClaudeAuthErrorResult`, `handleResultMessage`).

## Sync status

Last synced on 2026-08-26 against upstream `b0a0281269`. The pre-sync fork is
preserved at `backup/upstream-test-drive-pre-sync-20260826` (`1a1658c21`). At
that point, upstream `main` did not contain the fork behaviors above, so none is
retired solely by this sync.
