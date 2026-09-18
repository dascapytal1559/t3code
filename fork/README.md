# T3 Code fork

This file tracks the behavior this fork adds on top of
[upstream T3 Code](../README.md). The fork's desktop app is named
**T3 Code (Fork)**; upstream remains **T3 Code (Alpha)**.
See [Launch upstream](LAUNCH_UPSTREAM.md) for the separate upstream test copy
on this Mac.

## How the fork is wired

Top to bottom. Keep this map current when a layer, command, or doc is
added, removed, or moved; a new thing states which layer it belongs to.

- **Purpose.** Run this fork as the daily driver on the desktop and on the
  remote hosts in `deploy/remote-hosts`, tracking upstream T3 Code.
- **Feature ledger** (this file, the `##` entries below). What the fork adds
  and the tests that prove each entry. Every sync reassesses it.
- **Sync** (`SYNC_UPSTREAM.md`). Merging `upstream/main` into `main`:
  backup branch, merge, audit, reassess, and the migration-id rule (the fork
  owns id 50; upstream ids from 50 up shift by one). Sits on git and the
  Effect migrator.
- **Deploy** (`DEPLOY_FORK.md`, driven by `deploy/*.sh`). Landing a commit
  on the desktop and the remotes: migration gate, payload-or-DMG choice,
  build, stage, ship, swap. `deploy/deploy-status.sh` is the one-call
  picture of what is live where. Sits on the desktop payload override and
  the SSH package-spec override (both entries below), the Electron backend
  supervisor, and npm tarballs.
- **Deploy state**, all outside git: `release/.last-deployed-sha` and
  `release/.last-dmg-sha` (markers the swap scripts write on success),
  `~/.t3/fork/current` and `~/.t3/fork/builds/` (payload symlink and staged
  builds), `~/.t3/fork/deploy.log` (appended, timestamped, one header per
  run), `~/.t3/fork/ssh-t3-package-spec` (what the remotes run).
- **Shared Codex backend** (`SHARED_CODEX.md`, `restart-codex-backend.sh`).
  The shared Codex desktop backend setup on this Mac; independent of the
  layers above.

This file is the canonical fork-feature record. Update it when a feature's
behavior changes, not merely when syncing with upstream. Syncing from
upstream is `fork/SYNC_UPSTREAM.md`:
every sync reassesses these entries against stock upstream and drops
deltas that are no longer needed.

## Reality check

Every feature below ends with a **Tests:** paragraph naming the tests that
prove it still works. Fork-only test files end in `.fork.test.ts` and sit
next to the module they cover, so they never collide with upstream test
files during a merge; auth-recovery tests that need the upstream harness stay
inside `ClaudeAdapter.test.ts` with a `fork: ` name prefix. Run the whole fork suite from the repo root with

```
vp run test:fork
```

Run it after every upstream sync. Red means the merge is not finished:
either the fork code regressed, or the entry should have been retired and
its `.fork.test.ts` files deleted with it. A feature without a **Tests:**
paragraph is not done.

## Mermaid diagrams

Web and desktop render fenced `mermaid` blocks as diagrams in chat, Markdown
file previews, and PR descriptions. Rendering runs locally in the client and
loads Mermaid only when needed. Flowcharts default to top-to-bottom; the
direction toggle restores the original layout when preferred. This changes
only the rendered flowchart header, preserving labels, subgraph directions,
and the original source. Other diagram types keep their own layout rules.
Diagrams follow light/dark mode; wide diagrams scroll horizontally.
The Source/Diagram toggle and existing Copy code action
keep the original text available. Streaming responses show source until the
response finishes, and invalid or oversized diagrams fall back to source.
Mermaid dependency notices are registered in `third-party-licenses.config.json`
for the generated web license manifest. Native mobile continues to show Mermaid source using its separate native
Markdown renderer. This works with every provider and connection mode without
server or protocol changes.

Tests: `apps/web/src/lib/mermaid.fork.test.ts` renders real flowchart, sequence,
class, state, and entity relationship SVGs, checks theme separation and caching,
failure recovery, size limits, and hostile directives. SVG measurements are
stubbed because jsdom has no layout engine; this is not a visual layout test.
`apps/web/src/components/ChatMarkdown.mermaid.fork.test.ts` checks streaming,
source/diagram switching, copying source, ordinary fences, error recovery, and
stale async results after source/theme changes, and switching layout without
changing copied source. `apps/web/src/lib/mermaidLayout.fork.test.ts` covers
flowchart headers, frontmatter, comments, and preservation of other content.

## Remote host on thread cards

Upstream marks a sidebar thread row that lives on another machine with a
gray machine glyph in the branch line. The fork deals every remote
environment a color and draws its machine glyph in that color on the first
line of the card, right after the project name, so rows from different hosts
read apart at a glance without a label; the host's name stays in the row
tooltip and is read to screen readers as "Remote host: <name>". Colors are
dealt in catalog order from a fixed sequence of well-separated hues (blue,
orange, emerald, violet, rose, ...), so a host keeps its color as long as the
remotes added before it stay, and the sequence wraps after twelve hosts.
Threads on the primary environment, and on any environment that is a
desktop-local connection target (the same machine reached a second way),
carry no marker. In the hosted app there is no primary environment, so every
thread that is not desktop-local is marked.

Tests: `apps/web/src/environmentColors.fork.test.ts` covers dealing order,
stability when a later host is removed, duplicate ids, and wrap-around.
`apps/web/src/components/Sidebar.remoteHost.fork.test.ts` covers the
primary, desktop-local, remote, and no-primary cases of
`isRemoteThreadEnvironment`. The card markup itself has no render test; the
web package has no React render harness.

## Symlink-aware explorer and search

The native workspace scanner (`@ff-labs/fff-node`) does not traverse symlinks.
The fork supplements it with a cycle-safe, bounded walk that enumerates
root-level symlinks and follows symlinked directories, including targets outside
the workspace. Supplemental entries merge into the legacy whole-tree listing
and path search and obey the project's VCS ignores. The walk is capped at 5,000
entries and rebuilt when the workspace index refreshes. Search reports
truncation when unique supplemental results exceed the requested limit. The
lazy explorer follows symlinks directly as directories are expanded.
Opening a listed file uses the same workspace-relative path: `projects.readFile`
follows the link even when the target sits outside the workspace. Lexical `../`
escapes are still rejected.

Entries that are themselves symbolic links carry an optional `symlink` flag on
the `ProjectEntry` contract (omitted for regular entries; `kind` still reflects
the resolved target). The file explorer renders a small muted ↗ badge on those
rows — web/desktop through the tree's row-decoration hook, mobile next to the
row name. Descendants reached through a link are not flagged, and on web a
symlinked directory absorbed into a flattened single-child segment shows no
badge.

Implementation: `apps/server/src/workspace/WorkspaceSearchIndex.ts`,
`apps/server/src/workspace/WorkspaceFileSystem.ts`,
`packages/contracts/src/project.ts`,
`apps/web/src/components/files/FileBrowserPanel.tsx`, and
`apps/mobile/src/features/files/FileTreeBrowser.tsx`.

Tests: `apps/server/src/workspace/WorkspaceSearchIndex.fork.test.ts`
(symlinked subtrees, outside targets, nested and broken links, search and
truncation), `apps/server/src/workspace/WorkspaceFileSystem.fork.test.ts`
(reading through links that resolve outside the root),
`apps/server/src/workspace/WorkspaceEntries.fork.test.ts` (link kinds in
`listEntries({ directoryPath })`; search stays up when `git check-ignore` rejects a pathspec
beyond a link), and `apps/mobile/src/features/files/fileTree.fork.test.ts`
(the `symlink` flag stays on the linked node). The badge rendering itself
is not unit-tested.

`CLAUDE.md` is a symlink in this checkout; the explorer marks it with the muted
arrow badge:

![File explorer showing a symlink badge](./assets/symlink-explorer.png)

## Hidden-root visibility

The same supplemental walk exposes root-level dotfiles and dot-directories in
path search and the legacy whole-tree listing, where the native index omits
them. Upstream now includes those entries in its per-directory explorer. `.git`, `.DS_Store`, and upstream's `.convex` cache
exclusion remain hidden, as do paths ignored by the active VCS.

Implementation: `apps/server/src/workspace/WorkspaceSearchIndex.ts`.

Tests: `apps/server/src/workspace/WorkspaceSearchIndex.fork.test.ts`
(dotfiles listed; `.git` and `.DS_Store` still hidden).

![File explorer showing hidden root entries](./assets/hidden-root.png)

## Copy absolute path from the explorer and breadcrumbs

Right-clicking a row in the file explorer or a crumb in the file-preview
breadcrumbs offers **Copy absolute path** alongside upstream's **Copy
mention** and **Add to chat**. Both surfaces share a context-menu helper; the project-root crumb and
host-path crumbs for files outside the workspace offer only the absolute path,
since a mention cannot address either. The path is joined from the workspace
root with the entry's relative path, using backslashes under a Windows root.

Implementation: `apps/web/src/components/files/fileEntryContextMenu.ts`,
`workspaceAbsolutePath` in `apps/web/src/components/files/filePath.ts`, and
the right-click wiring in `FileBrowserPanel.tsx` and `FileBreadcrumbs.tsx`.
Upstream's own file actions (Open, reveal, and the **Open with** submenu from
`useFileContextMenu`) are handed to the helper by the explorer rows, so one
menu carries both sets.

Tests: `apps/web/src/components/files/filePath.test.ts` (`workspaceAbsolutePath`
joining, root handling, absolute pass-through, Windows separators).

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
query invalidation in web `useDirectoryEntries.ts`, `projectFilesQueryState.ts`,
mobile `useFileTreeEntries.ts`, and both clients’ `state/queries.ts` modules.
Loaded directories refresh without losing expansion state.

Tests: `apps/server/src/workspace/WorkspaceWatcher.fork.test.ts` (external
change refresh, cwd stream events, symlink-target watching, `notifyChanged`,
release after the last subscriber). The client query invalidation is wiring
and is not unit-tested.

The refresh control in the explorer is the manual fallback for the same
invalidation path. A still image cannot demonstrate watcher-driven updates,
but it does show the user-visible recovery control:

![File explorer with its refresh control](./assets/live-refresh.png)

## Tilde paths stay plain in chat

Inline-code mentions beginning with `~/` stay plain code rather than being
expanded against a home directory guessed from the thread workspace. This
avoids fabricating local links for paths mentioned on remote machines. Absolute
and relative path chips, explicit Markdown links, and image embeds are
unchanged.

Implementation: `packages/client-runtime/src/markdownLinks.ts` (inline-code
candidate) and `apps/web/src/markdown-links.ts`.

Tests: `packages/client-runtime/src/markdownLinks.fork.test.ts` and
`apps/web/src/markdown-links.fork.test.ts`.

![A tilde path rendered as plain inline code](./assets/tilde-path.png)

## Desktop runs a swappable server payload

When `~/.t3/fork/current` exists on the desktop machine and contains
`apps/server/dist/bin.mjs` (with `dist/client` inside) and a `node_modules`
resolvable from its root — the same shape as the app.asar server root —
packaged builds load the backend from it instead of the bundled server tree.
It is normally a symlink into `~/.t3/fork/builds/<sha>/`. Because the web
client is served by the backend, one payload swap updates both server and
frontend. A DMG rebuild is only for Electron/native/packaging runtime
changes; desktop tests and `test(…)` extracts of already-shipped override
readers stay on the payload path. `fork/deploy/choose-deploy-path.sh`
prints `payload` or `dmg`. When in doubt, payload.

The symlink path is handed to the backend supervisor unresolved, and the
supervisor respawns the backend child from that same path whenever it exits.
A deploy is therefore: retarget the symlink, terminate the backend, reload the
window — the app itself keeps running. Node resolves the entry to its real
path at spawn, so the outgoing backend keeps its own build until it exits;
the deploy scripts prune every other build only after the replacement is
verified to be mapped from the new one. A missing or
invalid target at launch falls back to the bundled tree; a target that goes
bad while the app runs makes the supervisor retry with backoff until it is
fixed. Development launches ignore the symlink.

The payload is staged from the same npm tarball the remote hosts install
(`fork/deploy/stage-server-payload.sh` extracts it into
`builds/<sha>` and runs `npm install`; `fork/deploy/swap-fork-payload.sh`
retargets the symlink and restarts the backend), so local and remote deploys
share one artifact. Which build is live is `readlink ~/.t3/fork/current`;
whether the override took effect is visible in the backend child's argv,
which contains the symlink entry path.

Implementation: `apps/desktop/src/app/DesktopForkOverrides.ts`
(`readDesktopServerRootOverride`), `apps/desktop/src/main.ts`, and
`apps/desktop/src/app/DesktopEnvironment.ts`.

Tests: `apps/desktop/src/app/DesktopForkOverrides.fork.test.ts` (override
detection returns the unresolved symlink path; missing or incomplete
payloads fall back) and `apps/desktop/src/app/DesktopEnvironment.fork.test.ts`
(the override applies to packaged builds only).

This payload selection has no distinct client UI state to capture.

## SSH launch runs the fork server

When `~/.t3/fork/ssh-t3-package-spec` exists on the desktop machine, its first
non-empty, non-comment line is used as the npm package spec for the remote T3
runner. An explicit override is authoritative even when a global `t3` binary is
already installed remotely. Remove the file to restore upstream's pinned
standalone release archive. Development SSH commands still take precedence
when explicitly configured.

Deploys are covered by `fork/DEPLOY_FORK.md`.
`fork/deploy/pack-server-tarball.sh` builds a SHA-versioned package for the remote
host, carrying pnpm-patched runtime dependencies inside it as bundled
dependencies since npm never applies the patches, and
`fork/deploy/swap-fork-app.sh` replaces the desktop app.

The generated runner script also turns npm's audit and fund calls off for the
package-spec install (`npm_config_audit=false npm_config_fund=false`). The
spec is a local tarball, and npm's audit request has hung indefinitely on the
remote hosts, stacking every launch attempt behind it until the launcher's
install check timed out.

Implementation: `packages/ssh/src/command.ts`, `packages/ssh/src/tunnel.ts`,
`apps/desktop/src/app/DesktopForkOverrides.ts` (`readSshPackageSpecOverride`),
and `apps/desktop/src/main.ts`.

Tests: `packages/ssh/src/command.fork.test.ts` (file parsing),
`packages/ssh/src/tunnel.fork.test.ts` (executes the generated runner with a
fake npm installer, preserving quoted package paths and disabling audit and
fund; blank overrides use the release archive), and
`apps/desktop/src/app/DesktopForkOverrides.fork.test.ts` (reading the
override file).

This remote-launch selection has no distinct client UI state to capture.

## Claude session recovery after latched auth errors

The Claude CLI latches into a logged-out state for its whole process lifetime
when its OAuth refresh fails (typically because a concurrent Claude process
rotated the shared credentials first): every later turn short-circuits to
"Not logged in · Please run /login" even after credentials are valid again.
Upstream keeps that process alive across turns, stranding the one thread while
new threads work. The fork detects auth-error results or upstream’s structured authentication
failure evidence, posts a runtime warning
to the thread, and closes the runtime so the normal teardown path emits
`session.exited`; the next message respawns the CLI, which reads the current
credentials and resumes from the persisted cursor.

Implementation: `apps/server/src/provider/Layers/ClaudeAdapter.ts`
(`isClaudeAuthErrorResult`, `handleResultMessage`).

Tests: `apps/server/src/provider/Layers/ClaudeAdapter.fork.test.ts` (which
results count as auth errors) and the `fork:` test in
`apps/server/src/provider/Layers/ClaudeAdapter.test.ts` (warning carries the
turn id, the turn completes, the runtime exits and the session is gone).

Recovery is a transient provider-process lifecycle, so there is no stable UI
state that honestly demonstrates it in a screenshot.

## Reverted messages stay removed after reload

User prompts have a null `turnId`. After a revert, the shared client reducer
keeps turn-less messages only when they predate the last retained checkpoint's
`completedAt`. Upstream's count-based fallback can retain the wrong prompts
because `thread.messages` is a paginated window while turn counts cover the
whole thread. Timestamp comparisons account for time-zone offsets, and
imported history remains intact.

Web and mobile snapshot caches use schema v5 so older cached ghost messages
are discarded once and refetched: the fork's revert fix took v4, and upstream
later used v4 for its own thinking-trace reload, so the fork moved one past
it to keep both invalidations. Upstream now restores the selected prompt
and attachments through **Edit from here**; the fork's old prompt-restoration
UI has been removed.

Implementation: `packages/client-runtime/src/state/threadReducer.ts`
(`retainMessagesAfterRevert`), `apps/web/src/connection/storage.ts`, and
`apps/mobile/src/connection/environment-cache-store.ts`.

Tests: `packages/client-runtime/src/state/threadReducer.fork.test.ts`
(retention after `thread.reverted`, including paginated windows),
`apps/web/src/connection/storage.fork.test.ts` and
`apps/mobile/src/connection/environment-cache-store.fork.test.ts` (v3 cache
records are rejected, v4 round-trips).

## Queue until idle on mobile

Mobile Send steers the running turn. The explicit Queue button holds a message
until the whole turn finishes, using `holdUntilIdle` on the existing outbox.
Held messages appear in the timeline as pending rows and can be returned to the
composer for editing.

Web and desktop use upstream's queue: it sends at a tool boundary and clears
on reload. The fork's separate persisted web queue has been removed.

Implementation: `apps/mobile/src/state/thread-outbox-model.ts`,
`use-thread-outbox-drain.ts`, `use-thread-composer-state.ts`, and
`apps/mobile/src/features/threads/ThreadComposer.tsx`.

Tests: `apps/mobile/src/state/thread-outbox.test.ts` (`holdUntilIdle` waits
while the thread is busy; unmarked messages still steer).

## Fork a thread

Codex and Claude desktop let you branch a conversation; upstream T3 Code has
only "New thread on branch" (a sibling with no history) and a destructive
revert. The fork adds a real fork: a new thread that holds the source
conversation through a chosen reply and continues it with the provider's own
memory of that conversation, leaving the source untouched.

Two entry points. "Fork thread from here" sits in the hover bar of every
settled assistant reply and copies the conversation through that turn,
inclusive. "Fork thread" in the thread action menu (sidebar row, chat header,
and the mobile row menu) forks through the latest settled turn. Both are
hidden on servers without the `threadFork` capability and on threads whose
provider cannot fork natively (Cursor and Grok have no fork wired), and
disabled while a turn is running. The fork inherits the source's project,
model, runtime and interaction modes, branch, and worktree, is titled
"<source title> (fork)", and opens as soon as its history lands.

On the wire a fork is a `thread.create` with `forkedFrom: { threadId, turnId
}`. The decider rejects sources in another project and forks through a
running turn; the event keeps the provenance. The fork dispatcher adds
`forkedFrom.cutoffAt` to the dispatched command: the request time of the
first source turn after the fork turn (pending rows included), or null when
the fork turn is the source's last. Every projector copies its own rows from
the source that were created before that instant (everything, on null), plus
the turn rows through the fork turn. Until 2026-09-10 the copy reused
revert's retention rules, which assume one prompt per turn and pad the user
side by count; a Claude prompt often spans several turns (background work
finishing after the reply opens a prompt-less synthetic turn) and a prompt
sent mid-turn steers into the running one, so the padding pulled in prompts
from after the fork point. Events recorded before `cutoffAt` existed replay
under the old rules. Revert still uses those count-padded rules and has the
same latent leak; it is upstream code and was left alone.
Message, activity, and plan ids are re-minted deterministically
from the fork's id (they are global primary keys). Imported message copies retain
upstream’s `import:` marker so later reverts preserve that history. Turn ids carry over
unchanged (Codex uses them as its own), and checkpoint refs move under the
fork's namespace with the git refs copied to match, so diff and revert work
on inherited turns.

Provider continuity is lazy and per adapter. The fork dispatcher asks the
source's adapter for a seeded resume cursor and persists it on the fork's
session binding; the fork's first message consumes it, so no provider process
runs at fork time and a fork that never sends stays free. Codex seeds
`{ threadId: <source>, forkLastTurnId }` and opens with `thread/fork`
(inclusive, never falling back to a fresh thread). Claude seeds the source
session id with `forkSession` and `resumeSessionAt`; to anchor older turns the
adapter now records each completed turn's final assistant uuid in the cursor
(`turnAnchors`). Upstream rollback now forks the native transcript and
replaces its message UUIDs; the fork remaps retained assistant anchors to those
new UUIDs so later conversation forks still target the surviving reply. The adapter advances that
cursor in memory, and until 2026-09-10 nothing wrote it back to the session
directory except the next `sendTurn`, a session restart, or a clean
shutdown, so the persisted cursor sat one reply behind: a thread that idled
out after its first reply could not be forked at all, and longer threads
forked from the previous reply while showing the latest one. The Claude
adapter now puts its cursor on the `turn.completed` event (an optional
`resumeCursor` payload field on the settled-turn events in
`packages/contracts/src/providerRuntime.ts`), and `ProviderService` persists
it before publishing the event, including when auth recovery has already
removed the runtime. Events without that payload use upstream’s live-session
cursor persistence. Turns whose cursor was never persisted, like turns
recorded before anchors existed, can only be forked from the latest reply.
OpenCode seeds the source session with the assistant ordinal and calls
`session.fork` at that message.

Implementation: `packages/contracts/src/orchestration.ts` (`ThreadForkSource`),
`apps/server/src/orchestration/threadFork.ts` (cutoff and id rules),
`decider.ts`, `projector.ts`, `Layers/ProjectionPipeline.ts` (per-projector
copies), `Layers/ThreadFork.ts` (dispatch ordering, checkpoint ref copy),
`provider/Services/ProviderAdapter.ts` (`conversationFork` capability,
`forkThread`), `provider/Layers/{Codex,Claude,OpenCode}Adapter.ts`,
`checkpointing/CheckpointStore.ts` and `vcs/GitVcsDriver.ts`
(`copyCheckpointRefs`), `packages/client-runtime/src/state/thread-fork.ts`
(client gating and title), `apps/web/src/hooks/useForkThread.ts`,
`apps/web/src/components/chat/MessagesTimeline.tsx` (`ForkFromTurnButton`),
`apps/web/src/components/threadActionMenu.logic.ts`, and
`apps/mobile/src/features/home/useThreadListActions.ts` with the mobile row
menus.

Tests: `apps/server/src/orchestration/threadFork.fork.test.ts` (cutoff, time
cut, and deterministic ids), `decider.threadFork.fork.test.ts` (fork-point
checks), `projector.threadFork.fork.test.ts` (command read model copy),
`Layers/ProjectionPipeline.threadFork.fork.test.ts` (SQL projections, turn
refs, shell summary; both projector tests cover the time cut keeping steered
and prompt-less turns while dropping the next prompt, and imported history
surviving a fork and subsequent revert), `apps/server/src/provider/Layers/CodexSessionRuntime.fork.test.ts`
(`thread/fork` open path, no fallback), `ClaudeAdapter.fork.test.ts` (seed
cursor, anchors, and the fork-point error wording), `ClaudeAdapter.test.ts`
(the settled turn's `turn.completed` carries the anchored cursor),
`ProviderService.test.ts` (that cursor is persisted when the turn settles),
`OpenCodeAdapter.fork.test.ts` (seed cursor),
`apps/server/src/environment/ServerEnvironment.fork.test.ts` (capability),
`packages/client-runtime/src/state/thread-fork.fork.test.ts` (client gating),
`apps/web/src/components/threadActionMenu.logic.fork.test.ts`, and
`apps/mobile/src/features/threads/thread-fork-menu.fork.test.ts` (menu items).
The end-to-end dispatch path (`Layers/ThreadFork.ts`) and the adapters'
session-start consumption of the seeded cursors spawn real providers and are
not unit-tested.

## Repository directory per checkout

A project can name a **Repository directory** other than its root, under the
Repository directory section of Settings → Project. The motivating layout is a meta
workspace: a directory of symlinks that gathers several sources, whose real
repository is one child. Commits, branches, pull requests, worktrees,
checkpoints, repository identity, and auto-pull run there; agents, file
search, the Open button, and project actions keep the project root. The
setting is per checkout and never fans out over a project group. Relative
input resolves against the project root on the client; the server stores
only an absolute, existing directory. Mobile follows the setting but cannot
edit it.

Implementation: `vcsRoot` on the project contract and the meta-update
command (`packages/contracts/src/orchestration.ts`), migration
`050_ProjectionProjectsVcsRoot` (live databases have applied id 50 under this
name, so upstream migrations numbered 50 and above are renumbered one higher
in the fork; see `fork/SYNC_UPSTREAM.md`), the resolver in
`packages/shared/src/projectVcs.ts` with the server twin
`resolveThreadVcsCwd` in `apps/server/src/checkpointing/Utils.ts`, and the
settings row in `apps/web/src/components/settings/ProjectSettingsPanel.tsx`.
`getActiveProjectByWorkspaceRoot` matches either root because git-facing
callers only know the cwd they ran in. The checkpoint reactor prefers the
thread's VCS cwd over the live session cwd only when a VCS root is set, and
provider-diff repository detection in `ProviderRuntimeIngestion.ts` resolves
the same cwd.

Tests: decider, projection pipeline, snapshot lookup, normalizer
(`Normalizer.vcsRoot.test.ts`), migration, shared resolver, the web path
input, a `CheckpointReactor` case where the agent runs in a meta workspace and
checkpoints land in the child repository, and `PullRequestService.test.ts`
cases where GitHub credential routing uses the repository directory.

## Desktop app named T3 Code (Fork)

The packaged desktop app is named **T3 Code (Fork)** and a development launch
**T3 Code (Fork Dev)**, instead of upstream's Alpha, Nightly, and Dev stage
labels, so the fork and a stock upstream build can sit side by side on one Mac
(see [Launch upstream](LAUNCH_UPSTREAM.md)). The name is fixed: a nightly-style
version does not switch it to Nightly, and a nightly primary server does not
relabel the web title. The bundle id, URL scheme, and the legacy
`T3 Code (Alpha)` profile directory names are unchanged, so the renamed app
keeps its existing Electron profile and data.

Implementation: `productName` in `apps/desktop/package.json` (read by
`scripts/build-desktop-artifact.ts` and
`apps/desktop/scripts/electron-launcher.mjs`), `resolveDesktopAppBranding` in
`apps/desktop/src/app/DesktopEnvironment.ts`, the `Fork` and `Fork Dev` stage
labels in `packages/contracts/src/ipc.ts`, and
`resolveServerBackedAppStageLabel` in `apps/web/src/branding.logic.ts`. The
deploy scripts read the same `productName` (`fork/deploy/lib.sh`) for the
installed bundle path, its executable, and the DMG volume name.

Tests: `apps/desktop/src/app/DesktopEnvironment.test.ts`,
`DesktopAppIdentity.test.ts`, `DesktopPreReadyPlatform.test.ts`,
`apps/web/src/branding.test.ts`, and `scripts/build-desktop-artifact.test.ts`
(product name and DMG title).

## Sync status

Last synced on 2026-09-18 against upstream `243e94470f`
(v0.0.43-nightly.20260918.1895, 140 commits after the previous sync). The
pre-sync fork is preserved at `backup/upstream-test-drive-pre-sync-20260918`
(`5affd436b1`). This sync kept every entry: it folded upstream's file actions
into the explorer context-menu helper, moved the thread-fork anchors onto
upstream's new Claude rollback remap, pointed upstream's relocated
provider-diff detection and the mobile review diff at the repository
directory, moved the snapshot caches to schema v5 behind upstream's v4, and
shifted upstream migration 053 to 054 behind the fork's migration sequence.
