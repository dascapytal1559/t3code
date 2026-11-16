# Fork changes

This fork tracks `pingdotgg/t3code` `main`. Each feature section says what it
does, shows a picture where one helps, then what each upstream sync must carry
forward. Keep this list current. Pictures live in `fork/media/` and show
made-up data. Earlier fork work is archived on the local branch
`archive/fork-legacy-2026-10-19` and is out of scope for syncs; take from it
only on request.

## Desktop identity

The fork's desktop app runs beside the official T3 Code on one Mac. Neither app
can read or migrate the other's database.

|                          | Official                                         | Fork                                        |
| ------------------------ | ------------------------------------------------ | ------------------------------------------- |
| App name                 | T3 Code (Alpha, Beta)                            | T3 Code (Fork)                              |
| Bundle id                | `com.t3tools.t3code`                             | `com.t3tools.t3code.fork`                   |
| Data folder              | `~/.t3`                                          | `~/.t3-fork`                                |
| Electron profile         | `~/Library/Application Support/t3code-v2` (Beta) | `~/Library/Application Support/t3code-fork` |
| First backend port tried | 3773                                             | 3873                                        |

The values are in `apps/desktop/src/forkIdentity.ts`. The app name is
`productName` in `apps/desktop/package.json`. `T3CODE_HOME` still overrides the
data folder.

Four things are still shared with the official app:

- The `t3code://` link scheme. Both apps register it, so macOS picks which app
  opens sign-in and prompt links.
- The `t3` command. A fresh install of either app links `~/.local/bin/t3` to
  its own launcher (the fork's is `~/.t3-fork/bin/t3`) unless a link is
  already there, and Install or Remove in either app's Settings takes over or
  deletes the other app's link.
- The default Tailscale Serve port, 443. Do not turn on Tailscale Serve in both
  apps at the same port.
- The managed policy (`/Library/Application Support/T3Code/policy.json` or the
  `com.t3tools.t3code` managed preferences). A policy written for the official
  app restricts the fork too, except that the fork ignores its update feed
  (`limits.updates.feedUrl`), so it never gets one
  (`apps/desktop/src/updates/DesktopUpdatePolicy.ts`). Upstream's `t3 update`
  command does follow that feed, but the app never runs it: its server is
  desktop-managed (`apps/server/src/cloud/selfUpdate.ts`).

## Usage reaches twelve months

![The Usage page's 12 months view: a year of daily cost as stacked bars, split by Codex and Claude Code](media/usage-12-months.png)

The Usage page on web and desktop has 6 months (`Cmd+Shift+5`) and 12 months
(`Cmd+Shift+6`) periods. Every period draws one stacked bar per day or hour,
because upstream's overlapping lines turn into a smear over long ranges. The
mobile app already draws bars and still
stops at 90 days. The server keeps parsed usage for 367 days instead of 92, so
usage stays after Claude Code deletes old transcripts. History older than what
is on disk or in the saved usage today cannot be recovered; twelve months builds
up from when this build first scans.

Upstream's "N malformed or inconsistent usage record(s) were skipped" sentence
shows as a small muted footnote at the bottom of the page instead of a notice
at the top (`apps/web/src/components/usage/UsagePage.tsx`).

## Usage rows can be muted

![The Usage page with Codex and Grok Build muted and grayed out, leaving Claude Code alone in the headline, chart and totals](media/usage-provider-filter.png)

On the Usage page, click a provider's dot, icon or name to mute it; click again
to bring it back. The row looks like plain text until you hover it. Muting grays
the row and leaves it in the list, showing what that provider would have added.
Everything else drops it: the headline, the other rows' shares, the chart, the
totals, the by-type bars and the breakdown. Rows follow upstream's order by the
selected metric (cost or tokens); a muted row ranks by what it would have added,
so muting it does not move it.

This is a second control on upstream's own filter, the provider menu in the
Usage header, and they share one saved setting. Keep that setting
(`hiddenProviders`) as the single source when syncing, and keep what the fork
adds: `excludedProviders` in `apps/web/src/state/usage.ts` and the rows in
`apps/web/src/components/usage/UsagePage.tsx`. Upstream's filter also hides a
provider's Limits cards, so a row muted here hides them too. The mobile app
has no row toggles.

## Usage accounts follow the providers tab

Wherever usage lists a provider's accounts (the Usage page's Limits columns,
the sidebar readout, the composer's `/usage-limits` panel, and the mobile app's
Limits view and widget), they go in the order Settings › Providers lists the
provider instances: the default instance first, then the others as saved.
Accounts no listed instance reports, such as hub-only accounts, go after, by
name. Upstream's `collectLimitPools` (#10690) orders accounts by the soonest
reset of their first window kind, so the account with a live five-hour session
jumps to the left; the fork keeps accounts where the providers tab puts them.
Both keep one order for every window row, so columns stay aligned. The rule is
`sortByProvidersTab` and `LimitAccount.providerOrder` in
`packages/shared/src/usageLimits.ts`; syncs must carry it.

## Usage limits in the sidebar

The captain wants usage visible without opening the Usage page, so the web and
desktop sidebar shows a small readout between the thread list and the bottom
icons: one line per account the Limits view shows, with its provider's icon, a
thin bar in the account's accent colour and the percent left in that account's
own weekly window, or its first window when it has no weekly one. A provider
with several accounts (Claude and Claude2) gets one line each, because each
account resets on its own clock. A provider's lines follow the providers tab
(see [Usage accounts follow the providers tab](#usage-accounts-follow-the-providers-tab)). Model windows such as Weekly · Fable stay on
the page. Each bar carries the Usage page's pace mark: a small line, in a gap
cut from the bar, where the bar would end if usage kept pace with the time
elapsed in that account's window. The tooltip names each account (its display
name, else the provider) with its figure, how much of the window is left and
its reset time, and says what the line means; a click opens the Usage page. It reads the same provider
statuses as the Limits view and fetches nothing, shows nothing until limits
arrive, and leaves out providers muted on the page. The phone web sidebar shows
it too; the mobile app does not.

Upstream code it touches, for syncs: `useLimitPresentations` is the Limits
view's environment and muted-provider filter, moved out of
`UsageLimitsSection` in `apps/web/src/components/usage/UsageLimits.tsx`, and
`saveUsagePagePreferences` now writes through `writeLocalStorageValue` so the
sidebar hears a mute in the same tab (`usagePagePreferences.ts`). The mount is
one line in `SidebarChromeFooter`. Code:
`apps/web/src/components/sidebar/SidebarUsageMini.tsx`.

## Archived usage

Usage includes copies of history from machines and accounts that no longer run
T3. The server setting `usageArchiveDirs` lists the archive folders. It
defaults to `["~/.t3-usage-archive"]` and can be changed in
`~/.t3-fork/userdata/settings.json`. Code: `apps/server/src/usage/usageArchive.ts`.

- Each folder directly under an archive folder is one host, and its name is
  the host label. Inside it, the copy keeps the original machine's layout, such
  as `<host>/home/.claude/projects`.
- These are read: Claude `projects/`, Codex `sessions/`, Grok
  `.grok/sessions/`, and a T3 server's saved usage
  (the newest `usage-scan-cache*.json` in a folder, version 3 on).
  Saved usage still has usage whose transcripts were deleted. Version 3 caches
  are priced at standard speed. OpenCode, Pi and Antigravity copies are not
  read.
- Archived usage is parsed and deduplicated like live history. Live
  directories are read first, so usage that is both live and archived counts
  once and stays credited to the live source.
- Archived folders join the live ones (`addArchivedDirs` in `UsageService.ts`)
  before upstream decides whether a provisional read can answer from saved
  usage, so an archived folder must be covered by a complete scan too.
- A remote that still runs T3 and is connected would be counted again next to
  its archive copy. Archive a host after T3 is removed from it.

## Usage by origin

The captain wants to see the prompts he sent from his phone and the work they
started, so the Usage page on web and desktop has a **Tokens by origin** bar
(Cost by origin): the period's usage split between phone and computer, direct
or coordinated, and Unknown for usage with no recorded parent. It is built from
what T3 records (see
[Messages record which client sent them](#messages-record-which-client-sent-them))
and what agents claim.

- A prompt is a user-role message. A run belongs to its `userMessageId`;
  messages that steer a running turn do not split it.
- Stamped messages go by `origin`: `mcp` or `bot` is Agent; `mobile` or
  `tablet` devices, and the native app, are Phone; `desktop` is Computer;
  anything else is Unknown. Unstamped messages: `creationSource` `mobile` is
  Phone (labelled as from the phone app, before stamps); `createdBy` `agent`
  or `creationSource` `mcp`/`provider` is Agent; everything else (older web
  messages, server-made messages) is Unknown.
- An agent prompt (Agent or crew) follows its recorded cause (see
  [Work records the prompt that caused it](#work-records-the-prompt-that-caused-it)):
  its own `causedBy`, else its thread's. If the chain reaches a Phone or
  Computer prompt within 8 hops, the prompt and its run count there, keeping
  the root's basis and adding `via` (`agent` or `crew`) for who sent it. A
  chain that ends at an uncaused prompt whose run is claimed (below) counts to
  the claim's device, so work a claimed turn caused inherits it. Any other root
  (an agent acting on its own, a server or unstamped prompt), a missing message
  or a cycle leaves the prompt where it was.
- Tokens are joined before aggregation: a transcript record's native
  `sessionId` finds the provider thread (`nativeThreadRef.nativeId`), and its
  timestamp the turn running then. A record more than five minutes after that
  turn completed, such as a terminal resume, belongs to no T3 turn. Origins split the
  kept records after dedupe and the model filter, counting a duplicate's merged
  copies once in upstream's `#accumulate` as its bucket does, so they add up to
  the page's totals.
- Agents claim what T3 can't trace with `t3_usage_claim`: a target of
  `sessionId` or `directory` (a session run outside T3, such as a pipeline),
  or `threadId` + `runId` (a turn whose prompt has no cause, such as a
  FirstMate wake), and a value of `causedBy` (counts like an agent prompt with
  that cause) or `device` (counts straight to `phone` or `computer`, basis
  `claim`: FirstMate marks upkeep `computer` and voice-journal work `phone`).
  A session claim may take `from` (an ISO time), for a session resumed for
  different work, such as FirstMate's supervision engine: a record counts to
  the session's latest claim started by then, and a record before every start
  traces as if unclaimed; a claim with no `from` covers the whole session.
  Claims live in the fork table `usage_claims`, one per target and start;
  claiming again replaces one, `causedBy: null` removes it. A claimed turn counts there unless its own
  prompt already traces. `t3_thread_read`'s `recentRuns` carry each run's
  `userMessageId`, a wake's notification included, so an agent can name a
  wake turn as `causedBy` for work it launches.
- A record in no T3 turn of its own session traces by claim, then by folder.
  A session or folder claim counts as above. Otherwise the
  record's working folder (`cwd`, kept by the scanner for Claude, Codex and Grok)
  decides: a folder named for a T3 session's native id (Claude's scratchpad),
  a thread's worktree, or a claimed folder, deepest first. A worktree counts to
  the latest turn started there by any thread, since slots are reused. A
  record of a T3 session past its turn, such as a terminal resume, never
  traces by folder.
- Usage still without a phone or computer settles in `settleOrigin`: with no
  recorded parent it is `unknown`/`default`, keeping `via` for agent work.
  (Fork builds before this sent it as computer `default`; the web counts any
  `default` row as Unknown.) Two kinds can never trace and keep a label
  instead: anything before `USAGE_ORIGINS_RECORDED_SINCE` (7 Nov 2026, when
  device stamps shipped) is `unknown`/`beforeOrigins`, and archived history
  from other machines is `unknown`/`archive`. The bar shows phone, computer
  and a grey Unknown segment; the legend lists the other two under "Can't
  trace".
- The scan cache keeps each record's `cwd` from the fork's v16. Moving from v15
  re-parses live Claude and Codex transcripts changed since 28 Oct 2026, when T3
  turns began; older files keep their saved records, which cannot trace by
  folder. Upstream's own v16 (Codex baseline time) arrived the next night, so
  the fork reads it as v17 and a fork v16 Codex file re-parses once; upstream's
  v17 (Grok turns keyed by time) is the fork's v18, so Grok files from a fork
  v16 or v17 cache re-parse once. Grok lines carry no folder, so its reader
  decodes the session's group folder name (or reads the `.cwd` file Grok writes
  for a name over 255 bytes); the fork's v19 re-parses Grok files changed since
  28 Oct once to add it. On syncs, an upstream cache bump becomes the fork's next
  number, never upstream's.

The server sends `origins` on `UsageSummary` (optional; usage rows keyed by
origin, basis, `via`, provider and source with no day, so the payload stays small),
and clients merge the rows with the same source ownership as buckets. The mobile app gets the merged
figures but does not show them yet. Code: `apps/server/src/usage/UsageOrigins.ts`
(classifier, cause chains, SQL, turn index), `attributeOrigin` and `countPrompt` in
`usageAggregation.ts`, `mergeOrigins` in `packages/shared/src/usageMerge.ts`,
and `apps/web/src/components/usage/UsageOriginBreakdown.tsx`.

## Claude banked resets on macOS

Upstream shows and redeems Claude's banked resets (weekly and Fable resets)
using the Claude Code login's access token, but reads that login only from
`<config folder>/.credentials.json`. On macOS, Claude Code keeps it in the
Keychain instead, so upstream skips macOS. It probably does that on purpose, to
avoid Keychain prompts and to avoid handling secrets there. The fork reads it on
macOS too, so Claude accounts there show banked resets the way Codex does.

- Each Claude provider instance reads only its own account's Keychain entry,
  through `/usr/bin/security find-generic-password`. It names the entry the
  way Claude Code does: `Claude Code-credentials`, plus `-` and the first 8 hex
  characters of the SHA-256 of `CLAUDE_CONFIG_DIR` whenever the CLI runs with
  that variable set. The account is `$USER`. The env used is the one the CLI
  itself gets (`makeClaudeEnvironment`).
- Only the access token is used. It stays in memory, and failures carry no
  output, so it never reaches a log, a file or a client. The login is never
  refreshed: a missing, denied, malformed or expired entry just means no
  resets show until Claude Code renews it. Redeeming is still a click.
- macOS may ask once per account to allow the read ("Always Allow").

When syncing, keep upstream's request, parsing and redemption code as is, apart
from the windows the fork also reads from that response (see
[Usage limits stay current](#usage-limits-stay-current)). The fork's part is `claudeKeychainService` and `readKeychainAccessToken`, called
from the darwin branch of `readAccessToken` in
`apps/server/src/provider/claudeResetCredits.ts`, plus the `cliEnvironment`
that `ClaudeDriver.ts` passes to it. If Claude Code changes how it names the
entry, update `claudeKeychainService` to match.

### Each limit row counts only the resets that refill it

Upstream offers each kind of reset (5-hour, weekly, Fable, full) as its own
option, but the Usage page badges every row with the account's total, so a
Fable-only reset shows on Session and Weekly too and can be redeemed from them.
The fork badges and offers a reset only on the rows it refills: Session gets
5-hour and full resets, Weekly gets weekly and full resets, and Weekly · Fable
(`seven_day_fable`) gets only Fable resets. A weekly row for any other model
Claude scopes (`seven_day_<model>`) gets none, so a second scoped model never
shows the Fable reset. The count, the segment's accessibility label, the
popover's Use buttons (web) and the account screen's reset list (mobile) all
follow it.

Upstream likely means to do the same: open PR pingdotgg/t3code#33553 (for
issue #33509) badges each grant only on the windows Claude says it clears, but it
reworks the server's grant reading and predates the per-kind options. The fork
keeps upstream's reading and only adds a `kind` to each option (`kind` in
`ServerProviderResetCreditOption`, set in `claudeResetCreditsToContract`).
`resetCreditsForWindow` in `packages/shared/src/usageLimits.ts` maps kinds to
rows and treats an option with no known kind as refilling every row. If upstream
lands per-window resets, take its version and drop the fork's `kind`.

## Usage limits stay current

Upstream reads Claude's 5-hour, weekly and per-model windows through the CLI
(`get_usage`) and caches that probe for 5 minutes, so Refresh on the Usage page
could show numbers up to 5 minutes old. Its periodic checks also pause while no
window is in front, and nothing says how old the numbers are. Anthropic computes
the numbers live on each read but limits how often it may be asked, so the fork
keeps the 5-minute interval and changes the rest:

- Claude's windows come from the `/api/oauth/usage` read that banked resets
  already make on every check (`readClaudeOauthUsage` in
  `apps/server/src/provider/claudeResetCredits.ts`, mapped by
  `claudeOauthUsageRateLimits` in `claudeUsageLimits.ts`). Every check,
  Refresh included, shows a fresh reading with no extra request. The CLI's
  cached reading is the fallback when that read fails, and still supplies
  monthly spend, which the read skips (`skip_spend=1`). The merge is in
  `checkClaudeProviderStatus` (`ClaudeProvider.ts`).
- A client coming back to the foreground gets one check if the last one is
  older than the interval, and the interval restarts from it
  (`foregroundReturns` in `apps/server/src/background/BackgroundPolicy.ts`,
  passed through `ProviderHost`, handled by `refreshOnForegroundReturn` in
  `packages/provider-core/src/server/managedProvider.ts`).
- Web and desktop say how old the numbers are wherever they show limits: each
  provider on the Usage page (its oldest account) and each account's popover,
  the composer's usage panel, the thread details panel, and the sidebar bars'
  tooltip (`apps/web/src/components/usage/LimitsUpdated.tsx`). The mobile app
  is unchanged.

When syncing, if upstream changes the usage read or Claude changes the response,
check `claudeOauthUsageRateLimits` against a fresh body; its test holds a
recorded one. If upstream adds its own foreground check or reading age, take
upstream's and drop the fork's.

## App-bundled CLIs are updated by their app

On macOS, a provider CLI whose real path is inside an app bundle
(`*.app/Contents/...`) is left to that app. T3 shows no Update button for it and
never runs its updater. Upstream already does this for the usual app-bundled
Codex, through the standalone check on `CodexDriver`. The fork guard covers the
rest: providers whose native updater has no such check (Pi's `update --self`,
Claude) and package-manager layouts inside an app. Without it they offer an
update that fails or changes the wrong copy. This works like upstream's handling
of WinGet's Claude, in `packages/provider-core/src/server/maintenanceResolver.ts`.

## `~` in a provider's executable path

A provider path that starts with `~` works for every provider. Upstream's Grok,
Pi and ACP registry drivers use a configured path such as `~/.local/bin/grok`
as written. Processes launch without a shell, so the provider shows as not
installed. Here each of those drivers expands a leading `~` with
`expandHomePath` before probing, spawning, resolving maintenance or reporting
status, as Codex, Claude, Muse, OpenCode, fx, Kiro and Antigravity do upstream
(fx, Kiro and Antigravity since upstream #35171, which replaced the fork's own
change there). Cursor never runs its `binaryPath`, so it is unchanged. When a
sync finds upstream expanding `~` in these drivers, keep upstream's.

## Idle agent release is a server setting

The server setting `providerSessionIdleTimeoutMinutes` (whole minutes from 1 to
1440, default 30, `null` is Never) replaces the hardcoded 30-minute idle
release. It has no control in the app: edit
`~/.t3-fork/userdata/settings.json`, for example
`"providerSessionIdleTimeoutMinutes": null`. The running server picks the
change up, including for agents already idle. Firstmate's environment sets it
to Never. This is the server half of upstream
https://github.com/pingdotgg/t3code/pull/25624, without its web and mobile
controls. When a sync finds the PR merged, or an upstream equivalent, drop
this copy and keep upstream's.

## Upstream release indicator

<img src="media/upstream-release.jpg" width="361" alt="The sidebar update icon's popover: T3 Code v0.1.5 is out. This build is v0.1.4. Ask FirstMate to sync the fork. Release notes and Dismiss buttons.">

The fork has no update feed, so it never hears about upstream releases. When
`pingdotgg/t3code` publishes a stable release newer than this build, the
sidebar update icon shows "T3 Code vX.Y.Z is out", with links to the release
notes on GitHub and a Dismiss that holds until the next newer release. Nothing
downloads or installs; the captain asks FirstMate to sync the fork. It checks
at start-up and every 6 hours, keeps the last result when GitHub is
unreachable, and stays off whenever an update feed is configured or the
desktop updater is running. Code: `apps/web/src/state/upstreamRelease.ts` and
`apps/web/src/components/sidebar/SidebarUpstreamRelease.tsx`; a later "Ask
FirstMate to update" button belongs in that popover.

## Board

![A chat beside its Board tab: a pasted Usage screenshot with a circle, an arrow and the note "Why the spike?"](media/board.png)

A quick annotation canvas that opens as a "Board" tab in a chat's right panel,
from the panel's launcher or "+" menu (W) or "Open board" in the command palette.
It is Excalidraw (MIT), loaded only when the tab shows. Screenshots pasted with
Cmd+V while focus is in the panel land in the middle of the view. The board is
saved in the client's IndexedDB, one board per client, shared by every chat's
Board tab. "Attach to chat" sends the selection, or the whole board, as a PNG to
the composer of the chat beside the panel, and "Copy" puts the same PNG on the
clipboard. The canvas is marked
`data-editable-canvas` and `role="application"` so its keys (tool letters, Cmd+Z,
Delete) are not taken by type-to-focus or thread undo. Code:
`apps/web/src/components/board/`.

Shared files it touches, for syncs: the `board` surface kind in `rightPanelStore.ts`
(and `closedViewStore.ts`), the launcher and "+" menu entries and tab title and icon
in `RightPanelTabs.tsx`, `RightPanelSurfaceContent.tsx`, `useRightPanelActions.ts`,
the props in `ChatView.tsx` and `PullRequestsPage.tsx`, a command palette item, the
selector in `lib/editableFocus.ts`, the Excalidraw font asset path in
`apps/web/vite.config.ts`, and licence notices. Excalidraw's canvas fonts are
served from the app because the desktop CSP blocks the CDN Excalidraw would
otherwise use. Excalidraw pins Radix Tabs 1.0.2, whose React peer range stops
at 18, and upstream's `strictPeerDependencies` refuses that, so an override in
`pnpm-workspace.yaml` moves it to a 1.1 release that accepts React 19. The
mobile app has no board.

## FirstMate crew in the sidebar

<img src="media/firstmate-sidebar.jpg" width="256" alt="The sidebar: a FirstMate card reading started 1d ago at top right, with two crewmate threads in a tree below it">

A FirstMate session and the worker threads it launches are grouped above the
sidebar inbox and kept out of Working. The main session is a two-line card: its
project and status, then its title. While it is idle, the status slot reads
"started 1d ago" instead of the last activity time, because age is what says a
long session is due for a fresh one; Working, Waiting and anything that needs
the user show as usual. The age is the thread's, since a `/clear` keeps the
thread. Neither it nor anything in its tree shows a branch line, since a worker's
branch matters little inside FirstMate; other threads and the hover card keep it
(`isThreadMetaLineEmpty` in `apps/web/src/components/Sidebar.logic.ts`). Its crewmates hang below it as a
tree that collapses to a count.
A pinned coordinator (see below) gets this card even with
no crew; without any coordinator the sidebar is unchanged.

The main session is always titled "Firstmate", because a generated title for
FirstMate says nothing new. T3 only knows the thread is FirstMate's once it is
pinned as coordinator, which FirstMate does during its first turn, after
upstream's title generation has started; so pinning sets the title and drops
the generation still in flight. A fresh session on it (`/clear`, or
`t3_thread_send` with `freshContext`) sets "Firstmate" again instead of generating;
upstream generates no title there anyway, so a rename by hand lasts until then.
A secondmate is crew of the main session and keeps upstream's titles, as does
every other thread. Upstream code it touches, for syncs: two guards in
`apps/server/src/orchestration-v2/Orchestrator.ts`, on `thread.metadata.update`
and on the initial title in `message.dispatch` (`isPrimaryCoordinator`).

No card in the sidebar, crew or not, has hover Snooze or Settle; the context
menu still has Snooze, and snoozing takes a thread out of the group. Upstream
shows both on hover so a thread is put away in one click; the captain asked
for them off so a stray click cannot put a standing agent's thread away
("We don't need the hover to settle or snooze"). Upstream's hover
code stays for syncs: the sidebar passes `hideHoverActions` to every row. The
crew cards drag only as chat context. A fresh
page load on the home route opens a coordinator whatever its run status,
the most recently updated if there are several, because a restart ends every
run. A thread's Lineage panel lists its Crew or Coordinator.

A coordinator can put a short status on a crewmate's card, such as "Testing":
`t3_thread_update` with `action:'set_status_label'` and
`statusLabel` (32 characters at most), and `action:'clear_status_label'` to take
it off. The label sits where Working, Done or the age would, so the title stays plain.
Approval, Input, Request, Limited, Failed and Woke still show over it, because a
label can lag behind a thread that needs the user. A label is stored with the
thread (`statusLabel`), thread reads report it, forks drop it, and changing it
does not count as activity. Upstream decoders ignore the field; web and desktop
show it, and mobile has no crew cards. Code: `resolveCrewStatusLabel` in
`apps/web/src/components/sidebar/coordinatorGroup.logic.ts`.

The label, not background work, says whether a crewmate is finished. Crew
threads keep upstream's background rule everywhere: only a task the agent waits
on with `t3_background_wait` holds a thread at Waiting, so a dev server or
monitor a worker left running does not. A worker that ends its turn to wait on
a validation run carries FirstMate's "Testing", and every other wait FirstMate
knows of has its own label, so an unlabelled worker between turns reads as
finished. Mobile shows crew threads with upstream's status and no label.

A crew card reading "Testing" also shows how long it has read that, with the
same running timer Working uses. Upstream only times a thread's own run, so a
card has no clock for anything else; a FirstMate worker in a validation run is
usually idle while it waits, so without one the card cannot say how long the
run has taken. The thread stores when its label was first set
(`statusLabelSince`). Setting the same label again keeps its time, and only a
new label or clearing it resets it.
Other labels show no timer. Code: the crew
label slot in `apps/web/src/components/sidebar/SidebarThreadRow.tsx`.

A crew thread names its coordinator at launch: `t3_thread_launch` takes an
optional `parentThreadId`, stored as the thread's `crewOf`. MCP thread reads
report it as `parentThreadId` with `relationshipToParent: "crew"`. It stays out
of the thread's `lineage`, which upstream-built clients such as the App Store
mobile app decode strictly; one unknown lineage value there stops their whole
thread list from syncing. Crew stored in lineage by earlier builds is read back
as `crewOf`. FirstMate passes its
main session's id, and a secondmate's workers pass the secondmate's, which
stays grouped with its own coordinator. The parent must be a thread the caller
can read; naming it grants nothing on it. Unlike `delegate_task` children, a
crewmate's Stop and archive stay independent of its coordinator. Threads
launched without a parent stay out of the group, and mobile does not group
crew. Code: `apps/web/src/components/sidebar/coordinatorGroup.logic.ts`.

A server restart ends the coordinator's session, and nothing inside it can wake
it again. So after each start T3 sends a coordinator one note, attributed to
T3 Code. Its first line is `The T3 server restarted at <serverStartedAt>.`; when
no saved restart request was found the next says "No restart request was found.
It may have crashed, been restarted by hand, or followed a machine restart or an
app upgrade." Then come the crew that had a run cut (or "None of your crew threads had a run
interrupted."), and then that its session ended with whatever lived only in it,
such as background commands, waits and monitors, and to run its session-start
steps again, check what is still running, and report. A thread pinned with
`t3_thread_configure` `coordinator: true` (one per project; pinning moves it,
`false` unpins) gets the note after every start, even with no crew or while
busy, in which case it queues behind the running turn. An unpinned coordinator
gets it only while idle with unarchived crew, and once its project has a pinned
coordinator, only when the restart cut one of its crew's runs. Archived,
settled or snoozed coordinators get none, and the project's continue-after-update
setting (`continueThreadsAfterServerUpdate`) turns notes off together with
restart continuation.

A coordinator whose own turn the restart cut is the exception. When T3 is about
to resume that turn, a separate note would start first and make T3 drop the
resume, so the pinned coordinator's resume message opens with the note instead,
followed by upstream's "Continue where you left off". If T3 declines that
resume when it comes to send it (a Stop the user asked for, a cut `/compact`,
the guard against a turn that keeps crashing the server, newer work on the
thread), the note goes out on its own. When T3 is not resuming the cut turn,
for example a run that was only waiting on background work nobody marked, the
note goes out on its own as usual. So a pinned coordinator gets exactly one
message per start that opens with the restart line, whether it was mid-turn or
idle; an unpinned one T3 resumes gets upstream's resume message alone.

`t3_restart_status`, and the restart request and cancel tools that return the
same status, report `serverStartedAt`: the ISO time the note quotes, set once
per server process. A coordinator compares it with the last one it handled to
tell a restart apart without reading process ids, which also works when it was
told nothing, such as with the setting off. Thread reads report `coordinator`,
and `orchestrator_capabilities` reports `coordinatorRestartNote`. Forks and
side chats drop the pin and the crew link, so forking FirstMate cannot make a
second coordinator. Code: `apps/server/src/orchestration-v2/CoordinatorRestartNote.ts`
and its two calls in `continueRestartedRun`
(`apps/server/src/orchestration-v2/RestartContinuation.ts`).

## A crewmate's message box sends to FirstMate

<img src="media/crew-reply.jpg" width="560" alt="The box at the foot of a worker's thread, holding a typed reply, with the context ring and a Send to FirstMate button">

Upstream treats every thread as a conversation the user can join. FirstMate
steers its workers through its own inbox and a message it sends over MCP, so a
message typed into a worker cuts across that. A crew thread (the sidebar's crew
membership, snoozed or settled too) has no composer: no model picker or branch
row, no way to type to the worker, and no way to unlock one.

In its place is a plain box whose words go to FirstMate, because the captain
reads a worker's report in its thread and wants to answer there: "if I'm ever
like reviewing a workers probe I could just reply right there". Sending puts
one ordinary user message in the worker's coordinator thread, queued behind a
running turn as the composer's Queue does, or starting a turn when the
coordinator is idle. The worker gets nothing. The message reads:

```
**Reply · <worker thread title>**
kept-thread: <worker thread id>

<the captain's words>
```

FirstMate reads the worker from the second line (`bin/fm-t3-worker-reply.sh`
in the FirstMate fork). `kept-thread` is the marker an earlier build sent and
that reader already knows, so it stays. Enter sends and Shift+Enter starts a
new line. The box takes text only, with no attachments, mentions or commands,
and keeps no draft when the user leaves the thread. It also carries the
[context window ring](#context-window-meter), for the worker's own window and
without Compact, since compacting a worker is FirstMate's call.

While the worker runs, a small Stop button sits above the box, and a Resume
button beside it (alone once the worker has stopped) whenever the composer's
Resume would show: an interrupted run to continue, or a queue held by Stop.
When the worker asks for an approval or asks a question, the full composer
comes back in place of the box until it is answered, because feedback and
custom answers use it. FirstMate's own thread and ordinary threads keep their
composer, and a thread gets it back once it leaves the crew (its coordinator or
itself archived). This is web and desktop only: the server takes messages for
crew as before, so FirstMate's MCP messages arrive unchanged, and mobile still
shows upstream's composer, which types to the worker.

Code: `crewComposerHidden` in `apps/web/src/components/ChatView.tsx`;
`CrewReply` and `CrewComposerGate` in `apps/web/src/components/chat/CrewReply.tsx`,
the message in `CrewReply.logic.ts`, and `CrewRunControls.tsx` beside them. For
syncs: `CrewComposerGate` stands where upstream's `<div className="relative">`
wraps the composer, so the composer's own lines keep upstream's indentation.

## Snoozed stays at the bottom, with no Settled

<img src="media/snoozed-pinned.jpg" width="256" alt="The sidebar: FirstMate with four workers, the top-level threads with a settled one among them, and the Snoozed row with its count at the bottom">

Upstream collects finished threads in a Settled section at the end of the
list, and its Snoozed row scrolls with the list. The captain puts a thread away
by archiving it and does not use Settled ("we're still not gonna need
settled"), so the web and desktop sidebar has no Settled section. The Snoozed
row, with its count and chevron, is pinned to the bottom of the thread list,
just above the usage readout, so a long list scrolls under it instead of
pushing it out of sight. Opening it scrolls the list to its end, where the
snoozed rows are; scrolled back up, the open row stays pinned.

A settled thread lists among the active ones, so nothing drops out of sight.
The thread menus (the card's context menu, a multi-selection's menu and the
chat header's) leave out Settle, Un-settle and Auto-settle behavior. Upstream's
settle paths still work: `Mod+Shift+S` settles and un-settles, a settled
thread's chat still shows its Settled line with Un-settle, and MCP and the
auto-settle setting still settle threads. The server does not offer clients
upstream's older-settled trim (`shellOlderSettled`), so every unarchived thread
reaches the list however many are settled; the mobile app's Settled shelf then
lists them all too.

The sidebar's shift guard, which drops a press on a row that just moved or
appeared without the user's input, leaves the pinned header alone: it never
slides under the pointer, and its position as the guard reads it follows the
scroll, so a press on it after a scroll was dropped.

Upstream code it touches, for syncs: the `SIDEBAR_SETTLED_SHELF` switch
(`apps/web/src/components/sidebar/settledShelf.ts`), read by
`partitionSidebarThreads`, the older-settled scopes, the list items and both
context menus in `Sidebar.tsx`, and by `useThreadActionMenu.ts`; the Snoozed
header's sticky classes and `toggleSnoozedShelfAndReveal` in `Sidebar.tsx`;
the drag projection in `Sidebar.drag.ts`, which leaves the pinned header
where the browser put it; `readTops` in `Sidebar.shiftGuard.ts`, which skips
sticky rows; and the `shellOlderSettled` capability left out of the server's
descriptor (`ServerEnvironment.ts`) and config (`ws.ts`). Upstream's Settled shelf tests do not apply: the
11/14 sync dropped "sidebar settled pagination" from `Sidebar.browser.test.tsx`.

## Indefinite snooze

<img src="media/indefinite-snooze-menu.jpg" width="512" alt="A thread's right-click Snooze submenu with Indefinitely first, above upstream's timed options and Custom…">

The captain wants to snooze a thread without picking a return time ("I want
the default snooze to be indefinite snooze"). Every snooze menu (the card's
context menu, a multi-selection's menu, the hover button upstream shows, and
the mobile app's swipe menu) starts with Indefinitely, above upstream's presets
and Custom…, which all stay. An indefinitely snoozed thread stays in Snoozed
until someone wakes it, or until whatever already wakes a snoozed thread wakes
it: a new message, a question or approval it raises, a failure, or pinning.
It sorts after timed snoozes and shows the alarm clock with no countdown (the
mobile row reads "Snoozed"); its chat says "Snoozed until you wake it", and a
usage-limit resume armed on it says it resumes when you wake it. Only
fork-built clients offer Indefinitely; stock clients show such a thread with a
countdown of millions of days.

It is stored as a wake time no clock reaches, `9999-12-31T23:59:59.000Z`
(`INDEFINITE_SNOOZE_UNTIL` in `packages/contracts/src/indefiniteSnooze.ts`), so
the wire command, the database and every upstream "snoozed while the wake is in
the future" check stay unchanged. Settings › Snooze options still edits only the
timed presets; Indefinitely is not one of them and always leads the menu
(`INDEFINITE_SNOOZE_PRESET` in `resolveSnoozePresets`,
`packages/client-runtime/src/state/threadSettled.ts`). MCP's
`t3_thread_organize` with `action: "snooze"` and no `snoozedUntil` snoozes
indefinitely (upstream refused it), and thread reads report an indefinite
snooze as `snoozed: true, snoozedUntil: null`.

For syncs: keep the Indefinitely entry first in `resolveSnoozePresets`, the
empty countdown in `snoozeWakeLabel`, the indefinite labels in
`useThreadLifecycle.tsx` and the mobile `ThreadDetailScreen.tsx`, and the MCP
default and read in `toolkits/thread/handlers.ts` and `threadSnooze` in
`OrchestratorMcpService.ts`.

## Only top-level threads alert

T3's thread alerts are the sound, toast and desktop notification chosen under
Thread notifications in Settings (off by default), and the paired phone's
alerts. In the fork they come only from a top-level thread: one that is nobody's
crew, subagent or side chat.

A thread launched as crew (it has a `crewOf`) raises no alert of any kind and
is not published to the phone, in any project and however it is grouped:
snoozed, settled, or after its coordinator is archived or gone. That covers its
approval, input and failed states as well as its turn ends, because its
coordinator answers for it: FirstMate watches its workers for a pending
question or approval and brings what needs the user to its own thread. A
subagent's or side chat's request shows on its parent, as upstream has it, so
it alerts only when that parent is top-level. A worker launched without a
parent is an ordinary thread to T3 and alerts as one.

On a pinned coordinator, a turn alerts at its end only when the user's own
message started it or was sent into it. Every other turn ends quietly:
background work reporting in, a delegated task finishing, T3's restart note, or
a message another agent sent. When such a turn needs the user, the agent calls
`t3_thread_update` with `action: "alert_when_done"` (no `threadId` means its own
thread) while the turn runs, and that turn's end then alerts as usual. The call
fails with `run_not_found` when the thread has no running turn, and it cannot
be taken back. The thread stores the turn as `alertRunId`, which does not count
as activity. Clients detect the action by `alert_when_done` in the tool's
`tools/list` `action` enum. Approval, input, request, failed and usage-limit
states alert on a coordinator as on any other top-level thread.

Upstream has no crew, so every listed thread is the user's own and alerts.
It also alerts whenever any thread's background work reports its end: a
terminal wake ("Command … finished") alerts at once, and a progress wake alerts
after a 5-second grace when no other turn follows (#32520), so the user hears
when unattended work finishes. The fork departs because a coordinator's
workers report to it, not to the user, and its own automatic turns are
supervision, not the user's work: FirstMate's thread runs thousands of turns,
most of them such wakes, and upstream would alert at the end of each. Other
top-level threads keep upstream's behaviour.

Code: `isTopLevelThread` and `latestRunEndsQuietly` in
`packages/shared/src/agentAwareness.ts`, used by the web and desktop gate
(`apps/web/src/components/ThreadNotificationCoordinator.tsx`) and the phone
relay; `isSupervisionRunForShell` and its SQL mirror `isSupervisionShellRun` in
`apps/server/src/orchestration-v2/ProjectionStore.ts`, which put
`latestRunSupervision` on the thread shell; and `alert_when_done` in
`apps/server/src/mcp/ThreadMetadataMcpService.ts`.

## FirstMate's doorbell folds to one short line

When FirstMate has a new instruction for a worker, it sends the worker one
fixed line (`: Firstmate instruction waiting: list "$FM_TASK_INBOX"/*.msg …`,
written by `fm_task_inbox_doorbell_line` in FirstMate's
`bin/fm-task-inbox-lib.sh`). In the worker's thread that card now reads
**FirstMate · New instruction** instead of "Agent" and the raw line; expanding
it shows the line as sent. The queued-runs control labels a queued doorbell the
same way. The worker's next step, reading the inbox file, already shows the
instruction itself.

Upstream shows text another agent sent exactly as sent, folded to its first
line under the sender's thread title or "Agent", so the user sees what the
agent was told. The fork departs only for this one line: it is a mechanical
pointer with the same words every time, so showing it says nothing. Only the
display changes; the stored message and what the provider receives are
untouched. The match is the whole line, so a message that merely mentions it
is shown as usual. The mobile app's thread card and queue label it the same
way. Code: `resolveAgentMessageFold` in
`packages/client-runtime/src/userMessage.ts`, used by
`TimelineUserMessageRow.tsx` and `QueuedRunsControl.tsx` in
`apps/web/src/components/chat/`, and by `AgentMessageFoldHeader` in
`apps/mobile/src/features/threads/ThreadFeed.tsx` and `QueuedRunSender` in
`apps/mobile/src/features/threads/ThreadQueueControl.tsx`. If FirstMate changes
the line, change the pattern with it.

## A fresh start on FirstMate ends the old session

Upstream closes the previous provider session on a fresh start (`/clear`, or
`t3_thread_send` with `freshContext`) only when it has no background work, and
leaves a busy one running: a queued fresh start leaves it up, and one sent to an
idle thread is refused. FirstMate's main session always has background work
(its worker monitor), so its old session kept running beside the new one. It
held FirstMate's session lock and went on dispatching and merging, and its
replies no longer reached the thread.

On a pinned coordinator that is not crew (`isPrimaryCoordinator`), a fresh start
now closes the previous session even when it is busy, ending its process and
background work before the new session's first turn. FirstMate's own records
carry anything it left mid-way to the new session. A fresh message still queues
behind a running turn as before. Every other thread, secondmates included,
keeps upstream's behaviour. Code: `retiresBusySessions` and its two uses in
`apps/server/src/orchestration-v2/Orchestrator.ts` (the queued start and
`message.dispatch`).

## A cold FirstMate thread starts fresh

Upstream never drops a thread's context on its own: a fresh session is the
user's `/clear` or a caller's `freshContext`, and for a large thread whose
prompt cache has expired it offers compaction, which keeps a summary. That suits
threads whose conversation is the only record of the work. On the pinned
FirstMate thread, a new exchange that starts after the cache has expired starts
in a fresh session. FirstMate keeps its state in files and rebuilds its context
at session start, about 71k tokens, while reloading or compacting the old
session re-sends all of it, 120k to 750k. Every other thread keeps upstream's
behaviour. This relies on Compact idle threads being set to Never for that
thread's provider.

The check runs when a run is about to start, at the two places a run starts, so
every client and route is covered, the stock phone app included. It starts the
run exactly as an armed `/clear` does, which also retires the old session. Cold
means the newest usage of the Claude session the run would resume reports a
cache expiry at or before now; a request served fully from cache reports none, so its time plus one
hour, Claude's longest cache lifetime, stands in. Other providers report no
expiry and are never cold. It applies only when that session is over 100k
tokens, since a smaller one reloads for about the price of a fresh start, and
when the run stays on the same provider. A message from any client or over MCP,
T3's restart note and a scheduled task begin an exchange. These continue the old
session instead: a steer, anything while a run is active or a question or
approval is pending, `/compact`, `/logout` and `/goal`, every other wake
(background work, a delegated task or a pull request watch reporting in, and any
wake the old session buffered), the continuations after a restart, a usage
limit or a manual Continue, and any start while the old session still has
background work running. An armed `/clear`, or a pending fork or merge-back,
leaves the start as it is. Inputs on one thread run one at a time, so two that
arrive together give one fresh session, and the second continues it. A cold
scheduled task's session becomes the thread's conversation, unlike a
fresh-session schedule's side conversation. The divider reads "New session ·
cache expired", above a message or the restart note. The stock phone app drops
the mark: it shows a plain "New session" above a message and none above the
note. If Compact idle threads is turned on, its
"When you return" compaction runs first, reloads the session and leaves it warm,
so nothing clears.

Code: `startsFreshOnColdCache` in
`apps/server/src/orchestration-v2/ColdCache.ts`, called where
`startNextQueuedRun` and `message.dispatch` start a run in `Orchestrator.ts`;
`freshContextReason` on user-message and notification turn items in
`packages/contracts/src/orchestrationV2.ts`; and the divider's
`cacheExpired` in `apps/web/src/components/chat/V2LifecycleRow.tsx`.

## Bridge

The right panel's "Bridge" tab is the captain's overview beside any chat: their
objectives on top, then FirstMate's model routing table. Both are read-only and
pushed by FirstMate. Upstream's right panel has no tab for an outside agent's
standing information; the fork adds this one so the captain can glance at both
from any thread. It opens from the panel's launcher or "+" menu (N), or "Open
Bridge" in the command palette. On phone web it opens as a sheet like the other
right-panel tabs.

Each section (Objectives, Model routing) has a header
with a chevron and its count, where it has one, that collapses and expands it.
Each client remembers what it collapsed in local storage
(`t3code:bridge:collapsed:<section>`), so it survives a reload. Objectives has a
pin in its header: pinned, it stays open and its header cannot collapse it;
unpinned, it collapses like the others. A new client starts pinned, and the pin
is remembered the same way (`t3code:bridge:objectives-pinned`).

Objectives are a short Markdown list FirstMate pushes (see the records below),
shown read-only as one card per top-level bullet: its bold
lead as the card's name over the rest of it, a summary of about two lines, in
full. The cards wrap in a grid, one column in a narrow panel and side by side
as it widens, cards in a row sharing a height. With none set there are no
cards. The tab shows the objectives of the chat's own
environment, else of the first connected environment that has some.

Model routing is FirstMate's routing table (its `config/crew-dispatch.json`: a
"when" sentence naming a kind of work, the harness, model and effort it routes
to, and why, plus a default), pushed as a Markdown table and shown read-only
after the objectives. A wide panel shows the table. Below 36rem (a narrow panel,
phone web) each row stacks instead of scrolling sideways: the first cell as its
title, the middle cells on one line joined by " · ", the last cell beneath. With
none set the section does not show. Like objectives, it is the chat's own
environment's, else the first connected environment's that has one.

The records, for FirstMate's side:

- `t3_objectives_set` replaces the objectives, which T3 keeps in this
  environment's server settings (`objectives` in `settings.json`), so they
  survive a restart and reach every connected client on the settings stream.
  Input: `{ markdown: string | null }`.
  `markdown` is the whole list, at most 8,192 characters, trimmed and not
  empty, normally one bullet per objective: `- **Name** — a sentence or two`;
  send the list only, with no heading or "Last reviewed" line. `null` clears
  them. Each call replaces the whole value; a `lastReviewed` key from an older
  caller is ignored. The result is `{ objectives: { markdown } | null }`, the
  stored value. Like `t3_environment_preferences_update` it needs
  a full-access client or a live full-access caller thread, and refuses a
  linked environment's caller. The captain cannot edit them in T3.
- `t3_routing_set` replaces the model routing table the same way, kept as
  `modelRouting` in `settings.json`. Input: `{ markdown: string | null }`, the
  whole Markdown table (header row first, one rule per row, the default as the
  last row), at most 8,192 characters, trimmed and not empty; `null` clears it.
  The result is `{ modelRouting: { markdown } | null }`. Same access rules and
  refusals as `t3_objectives_set`. The captain cannot edit it in T3.

Code: `packages/contracts/src/objectives.ts` and
`apps/web/src/components/bridge/`, where the collapsible sections and the pin
live in `BridgeSection.tsx`; the routing table's stacked layout is the
`.bridge-routing` block in `apps/web/src/index.css`. Shared files it touches,
for syncs: the `objectives` and `modelRouting` fields in `ServerSettings` and
`ServerSettingsPatch` (`settings.ts`), their whole-value replace in
`applyServerSettingsPatch` (`packages/shared/src/serverSettings.ts`), the tools
in `mcp/toolkits/environment/`, their rows in `t3McpToolPresentation.ts` and the
larger `agentContextBudget.json`; on the web, the surface kind in
`rightPanelStore.ts` (and `closedViewStore.ts`), the launcher and "+" menu
entries and tab title and icon in `RightPanelTabs.tsx`,
`RightPanelSurfaceContent.tsx`, `useRightPanelActions.ts`, the prop in
`ChatView.tsx` and a command palette item. The surface kind is still
`needs-me`, the tab's first name: each client's saved panel state lists its
open tabs by kind, so a renamed kind would leave a blank tab where the Bridge
was.

## Restart registry

Whoever restarts T3 (FirstMate installing a build) first registers the restart,
so no new turn starts and nobody's message is cut off. While it is pending:

- No turn starts on any thread. A send from the composer, `t3_thread_send` or
  any other path queues on its thread, held, even on an idle thread; a steer
  queues instead of joining the running turn, a restart send or `/goal`
  queues without stopping it, and a queue resumed by hand is held again.
  Messages already queued are held too. Nothing is dropped. A workspace launch
  still prepares its worktree and is held when it would start. The one refusal
  is a fork's first message, which needs the immediate start path; promoting a
  queued message to a steer is refused too.
- Turns already running finish normally.
- The web app shows a notice naming the reason, with Cancel restart, and the
  composer's send button reads as Queue.

The restart's holds are kept apart from Stop's and failures': a run held for
the restart has `queueHeld: true` and `restartHold: true`. Only the restart
releases those, and a Stop during the wait takes the hold over, so that queue
stays stopped afterwards. After the restart, server start releases every
restart hold and each thread's queue runs in order with nobody acting; a cancel
releases them the same way. A send that races a cancel can still commit a
restart hold after the release sweep, so whatever writes one (a command's
commit or the queued-run start's own hold) re-checks afterwards and releases
the thread's restart holds when no restart is pending (`releaseStrayRestartHolds`).

MCP tools, on the environment toolkit. Request and cancel need a full-access
client or live full-access caller thread, and refuse a linked environment's
caller, like `t3_objectives_set`; status needs only orchestration access.

- `t3_restart_request` `{ reason, causedBy? }` sets the request (`reason`:
  trimmed, 1 to 500 characters, such as `install build 0.1.8`), or replaces
  its reason and cause when one is pending. `causedBy` is the prompt whose work
  the restart installs, checked like `t3_thread_launch`'s; FirstMate passes the
  latest landed task's cause. `requestedBy` is the caller thread's title or the
  MCP client's label. Returns the status below.
- `t3_restart_status` `{}` returns `{ pending, reason, requestedAt, causedBy,
  activeTurns, drained, serverStartedAt }`. `activeTurns` counts threads with a
  turn in flight (preparing, starting, running or waiting on a person), in any
  project, including the caller's own; `drained` is `pending` and
  `activeTurns === 0`. `reason` and `requestedAt` (ISO 8601) are null when
  nothing is pending. `serverStartedAt` (ISO 8601) is when this server process
  started, so it changes across the restart the request waited for (see the
  restart note under [FirstMate crew in the sidebar](#firstmate-crew-in-the-sidebar)).
- `t3_restart_cancel` `{}` clears the request and releases its holds. Returns
  the status.

T3 never restarts itself: the requester polls `t3_restart_status` from outside
any turn until `drained`, then quits and relaunches T3. The pending request is
saved to `<stateDir>/restart-request.json`, so the next server start reads what
the restart was for (`restartedFor`) and removes the file; a cancel removes it
too. The held runs persist in the projection until that start releases them.
The restart note carries the request's `causedBy`. A restart continuation
counts where the cut turn counted: to the prompt a person typed, or to that
prompt's `causedBy`; only a turn with neither, in a thread with no cause of its
own, takes the request's. Code: `RestartRequestFile.ts`, `cutRunCause` in
`RestartContinuation.ts`.

Clients read it on the `subscribeRestartRequest` stream (`{ request: {
reason, requestedBy, requestedAt, causedBy? } | null }`) and cancel with
`server.cancelRestartRequest`. The web app follows only its primary
environment. Mobile gets the server-side queueing but shows no notice yet; it
hides Resume on a thread whose queue holds a restart-held run, and its queue
sheet says the queue waits for the restart (`isRestartHeld` in
`packages/client-runtime/src/state/threadWorkflows.ts`).

Code: `packages/contracts/src/restartRequest.ts`, the `restartHold` run field
in `orchestrationV2.ts`, the two RPCs in `rpc.ts` (with their scopes in
`clientRpcPermissions.ts`, `RpcAuthorization.ts` and `RpcInstrumentation.ts`)
and `ws.ts`. In `Orchestrator.ts`: the request state and `requestRestart`,
`cancelRestart`, `restartStatus` and `releaseRestartHolds`; the gate in
`startNextQueuedRun`, `dispatchMessage` (idle threads queue, steers and `/goal`
stops queue) and `prepared-run.release`; the steer-promotion refusal;
`withQueueHold` at the release sites (unattended release, user send,
preparation retry, Stop, queue resume). The recovery kinds in
`ProjectionStore.ts`, the hold strip in `ProviderRuntimeRecoveryService.ts`,
the startup release in `serverRuntimeStartup.ts`, the tools in
`mcp/toolkits/environment/` with rows in `t3McpToolPresentation.ts` and the
larger `agentContextBudget.json`; on the web, `useRestartPendingBanner.tsx`
(a notice in the composer's banner stack, above the message box),
`useRestartPending.ts` and the `restartPending` prop
of `ComposerPrimaryActions.tsx`.

## One-line thread cards

<img src="media/one-line-cards.png" width="256" alt="Five one-line sidebar cards: each starts with its project's icon (a dashed speech bubble for No project, letter tiles for the others), then the title, then its age">

The captain wants each top-level thread on one line. On web and desktop, a
sidebar card outside the FirstMate group is one line: the project's icon (the
dashed speech bubble for a No project thread), then the title (or the project's
agent name), then the status or age. Upstream's card has a project line over a
title line. The card shows neither the model nor the account; the hover card
keeps both. A card with a branch, machine
label or diff keeps that meta line under the title. Otherwise its PR and
terminal badges sit on the title line, which truncates before them, the same
as folder multi-line rows (`isThreadMetaLineEmpty` in
`apps/web/src/components/Sidebar.logic.ts`). The hover card and the
screen-reader label still name the project and the model. FirstMate's coordinator card and its crew keep
the two-line layout.

Every row draws only the account the thread runs on now. Upstream draws up to
two greyed earlier accounts in front of it from `providerInstanceHistory`, to
show that a thread was handed from one provider account to another; here that
history stays in the hover card.

The account badge shows a number, and that applies app-wide on web and desktop,
not just in the sidebar: the composer's model picker, model lists, subagent bar,
lineage and timeline rows all show it. The number is the account's place among
its provider's accounts in Settings › Providers (default first, then as saved,
the order usage limits follow), so Claude, Claude2 and Claude3 read 1, 2 and 3.
Upstream's badge shows the first two letters of the account's name, and every
"ClaudeN" reads CL. A provider with one account shows no number, and an account
accent colour still tints the badge (upstream's main way to tell accounts
apart). Disabled accounts keep their number, but removing an account renumbers
the ones after it, and each environment numbers its own. Screens that print the
account's name beside its icon (the Settings › Providers card, Usage) show the
accent dot without a number, since the name is already there.

Upstream code it touches, for syncs: the card branch of `SidebarThreadRow`
(`oneLine`, `titleOnTopLine`) and `SidebarModelIcon`, which replaces
upstream's `SidebarProviderStack`, in
`apps/web/src/components/sidebar/SidebarThreadRow.tsx`; `accountNumber` on
`ProviderInstanceIcon`, which replaces upstream's `badgeContent`, and on
`ProviderInstanceEntry`, set by the entry helpers in
`apps/web/src/providerInstances.ts` (`numberProviderAccounts`); and each badge
caller passing `entry.accountNumber`. The numbering is `providerAccountNumbers`
in `packages/shared/src/usageLimits.ts`. The mobile app has its own provider
icon and keeps upstream's rows and initials badge. Leave
`resolveThreadProviderStack` and `providerInstanceHistory` as upstream has them:
mobile and the hover card read them.

## Agent names on cards

A project can carry an agent name (**Settings → Projects → Agent name**, or
`agentName` on `t3_project_update`; `null` clears it) for a standing agent such
as a life log. Its thread cards on web and desktop then show the agent name as
their heading in place of the thread title, with no project line, and the hover
card keeps the real title and project. Folder rows keep the thread title.
Mobile is unchanged. The column (`agent_name`) is added by
`apps/server/src/persistence/forkSchema.ts` after upstream's migrations rather
than by a numbered migration, which would collide with upstream's next id. Code:
`resolveThreadCardHeading` in `apps/web/src/components/Sidebar.logic.ts`.

## No repeated project name on cards

This now matters only for FirstMate cards, the one place a card still has a
project line (see [One-line thread cards](#one-line-thread-cards)). When a
thread's title matches its project's name (ignoring case and surrounding
spaces), as for a standing thread named after its project, the card leaves the
project label out of its first line, which keeps the project icon, pin, status
and time. The title line is unchanged, and the hover card and screen-reader label
still name the project. Code: `projectLabel` from `resolveThreadCardHeading`.

## Thread details open hidden

Upstream shows the thread details card on every thread until you hide it. Here a
thread you have not toggled opens with the card hidden, unless **Settings →
Appearance → Show thread details by default** is on. Each thread remembers when
you show or hide it, whichever way the setting points. Code:
`threadDetailsDefaultOpen` in `packages/contracts/src/settings.ts` and
`defaultThreadPanelVisibility` in `apps/web/src/rightPanelStore.ts`, whose
persisted map now keeps open choices too.

## Context window meter

The composer's footer shows a ring for how full the thread's context window
is. Hovering it opens the usage, total processed tokens, cost, the
auto-compact threshold and a Compact context button when the provider has
`/compact`. It shows on web and desktop with no setting; mobile has none.
Upstream's #33131 (8 Nov 2026) deleted it with the Labs toggle that hid it,
"Context window indicator (legacy)". The fork keeps the meter, not the toggle,
because a glance at the composer is the quickest way to see when a long
thread needs compacting. A FirstMate worker's thread, which has no composer,
shows the same ring on its
[reply box](#a-crewmates-message-box-sends-to-firstmate) so the captain can see
how much context each worker holds; there it has no Compact context button.

Upstream's branch `maria/redesign/6-workspace-panes` has its own view of what
fills a Claude thread's context ("feat(web): show what fills a Claude thread's
context window"). If upstream ships a context view like it, drop this meter
for theirs.

For syncs, the meter lives in `apps/web/src/components/chat/ContextWindowMeter.tsx`
and `ContextWindowMeter.logic.ts`, both fork files. Upstream files it touches:
`ComposerFooterControls.tsx` (renders it before the primary actions),
`ChatComposer.tsx` (the context window, thread shell, sync phase and compact
props), `ChatView.tsx` (passes them, and `compactDisabledReason`), and
`compaction.logic.ts` (exports `providerSupportsManualCompaction`), plus a
sentence on the ring in `docs/user/composer.md`. The fork's `CrewReply.tsx`
renders it too. The meter
offers no Refresh context; the fork removed that feature.

## The window grows for the right panel

![The desktop app with a README open in the right panel: the window grew by the panel's width, and the sidebar and chat kept theirs](media/window-grows-for-panel.jpg)

In the desktop app, opening the right panel (a file link, the Files list, any
surface) widens the window to the right by the panel's width, so the sidebar
and chat keep the widths you chose. Closing it takes the panel's width as it is
then back off. Upstream's panel shares the window, so the window never moves or
resizes on its own. The fork changes that on purpose: the window is kept at a
chosen width, and opening a document used to squeeze the chat to make room.

- The chat column keeps its width and the panel takes the rest of the row, on
  desktop and in the browser alike, so a window resize or a sidebar toggle
  while the panel is open lands on the panel. Only the desktop window resizes
  itself; the browser keeps upstream's per-thread widths, and desktop keeps
  one (`t3code:preview-panel-width`).
- Opening draws first, then grows. macOS shows a grown window at once, with the
  page's last frame and a blank strip beside it, and Chromium does not hold a
  resize for the page. So the page's own view is widened past the window's
  edge, the page lays out and draws there at the grown size while the window
  still clips it, and only then does the window grow, over a frame that is
  already there. Closing shrinks the window at once and the page follows.
- The panel joins the layout in the resize that widens the page and leaves in
  the one that narrows it, never before. The chat has no frame at another
  width, and the panel is never laid out inside the old window. A window
  narrow enough for the sheet layout opens the same way, inline once it has
  grown; the sheet shows only when the window cannot grow.
- Nothing is held, timed, animated or faded. The window answers a request once
  it has its bounds and the page has drawn at them (a one-second cap covers a
  page that cannot draw), and the answer settles the layout on what was asked;
  until then the layout follows each resize, so a toggle back, a hand resize
  or a thread change mid-way never leaves the chat at another width.
- Electron's `BrowserWindow` keeps its page view to itself, so on macOS the
  view is sized through the Objective-C runtime (`ffi-rs`). Where that cannot
  be done (another platform, DevTools docked beside the page, a Chromium that
  names the view differently) the window resizes first and the page follows,
  which shows the blank strip for as long as the page takes to draw.
- For the frame between the page drawing and the window growing (about 17 ms)
  the old window already shows the grown layout: the chat header's layout
  buttons take their open look that much early. A surface's first open after
  launch loads its code and data only once it is mounted, as upstream's lazy
  surfaces do, so that one time the window grows with the panel's tabs drawn
  and its body fills in a moment later.
- Near the screen's right edge the window moves left only as far as it must
  and moves back on close. A screen too narrow for the full width grows as far
  as it can and the chat gives way for the rest. Full screen and maximized
  windows are left alone.
- A hand resize while the panel is open goes to the panel, so closing takes it
  off with the panel. The window's saved size leaves the panel's width at
  opening out, so a restart with the panel open grows once.
- The window follows whether the panel is showing, so switching between a
  thread with the panel open and one without resizes it.
- The growth is converted from CSS pixels to screen points, so it matches the
  panel at any app zoom.

Code: `apps/desktop/src/window/PanelWindowGrowth.ts` (the width arithmetic and
the order of page and window, with its tests),
`apps/desktop/src/window/PanelPageView.ts` (the page sized ahead of the window,
and the frame it draws), the `setRightPanelOpen` bridge method,
`apps/web/src/hooks/useRightPanelWindow.ts` (the layout following the page's
resizes), and `apps/web/src/hooks/usePreviewPanelInlineSize.ts` (the kept chat
width), each web hook with its browser test.

## A closed Claude session waits for its CLI to exit

Upstream's `/clear` ends the thread's agent session and opens a fresh one. On
the FirstMate thread the old Claude CLI process must be gone first: FirstMate's
session lock belongs to the live process, and a new session that loses it comes
up read-only. Upstream's close only schedules the CLI's SIGTERM, so the fork's
Claude adapter also waits for the process to exit, up to 15 seconds, whenever a
session closes. Code: `awaitExit` in
`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`.

The fork once had a Refresh context button for this. Its first version wrote a
`thread.session-replaced` event; nothing writes it now, and the contracts keep
it so stored events still decode.

## Per-thread environment and instructions

An agent that launches a thread can give it its own environment variables and
instructions. `t3_thread_launch` takes optional `environment` (env vars, at most
64 and 16 KB, never T3's own names) and `instructions` (kept in the agent's
system context, at most 16,000 characters), stored on
the thread so they survive idle release, restarts and forks, though not
delegated children. Values sit in the database, so they must not be secrets. Each
adapter applies them through the channel it already has and declares what it
supports; a launch or later turn that binds something its provider cannot
apply is refused. Kiro's adapter declares neither, so it refuses both. Cursor
takes instructions only, because it runs inside the server process. The other
providers take both. `t3_thread_configure` reads them back with the effective
runtime mode, and `orchestrator_capabilities` reports `threadEnvironment`,
`threadInstructions` and an ACP registry instance's `agentId`. Code:
`apps/server/src/orchestration-v2/RuntimePolicy.ts`.

OpenCode 2 shares one server per instance, so its adapter sets each session's
own environment instead (`PUT /api/session/:id/environment`). That replaces the
server's environment in the session's shells, is kept in memory only, and is not
inherited by subagent sessions. So T3 sends every session, subagents included,
the environment it started the server with minus `OPENCODE_PASSWORD`, plus the
thread's variables. It sends this again after the server restarts. An external
server (`serverUrl`), on either OpenCode adapter, has an environment T3 does not
know or cannot reach, so it takes instructions only. Code:
`packages/provider-opencode/src/server/v2/adapter.ts`.

## Agents answer approvals over MCP

Claude asks for some commands even with full access (its own safety checks and
the user's ask rules). An agent driving T3 over MCP, such as FirstMate, can
answer those so the user never has to. `t3_pending_request` `list` returns
`approvals` next to question `requestIds`, each with its `kind`, `detail`,
`reason` and `override` (`provider_check`, `ask_rule` or `null`); `respond`
takes `decision: "allow" | "deny"` and optional `feedback` on deny, and sends
the same command the Approve and Decline buttons do. Only a full-access caller
other than the asking thread may answer one. The resolved request and its
timeline row record `respondedBy: "agent"`, which web and mobile show as
"answered by agent". `orchestrator_capabilities` reports `approvalResponses`.
Code: `apps/server/src/mcp/toolkits/thread/handlers.ts`.

## Stopped turns close their approvals

Upstream closes only a stopped turn's questions, so an approval such as a Claude
command prompt stays pending forever: the app keeps showing a prompt for a tool
call that no longer exists, and the thread reports a pending request. Here a turn
that ends interrupted, failed or cancelled expires every pending request it
raised. A turn that completes still closes only its questions, because a
background subagent's approval can still be live then. These requests close as
`expired`, not `cancelled`, and the guard that keeps a just-committed answer from
being overwritten covers every request kind. Code: `expireTurnRequests` in
`apps/server/src/orchestration-v2/ProviderEventIngestor.ts` and
`guardRequestClosures` in `EventSink.ts`.

## Waits end on a question or approval

T3 sends an MCP client no event when a thread starts waiting on a question or
approval, so FirstMate used to re-list every watched thread's pending requests
once a second, at about 40 ms of server CPU per check. Now `t3_thread_wait`
takes `settleOnPendingRequest: true` and also returns, at once, when a
question or approval appears that the caller does not know of: one outside
`knownRequestIds`, or, without that list, one not pending when the wait
started. It listens to the thread's `runtime-request.updated` events on the
subscription the wait already holds, so it costs nothing while idle. The
result then carries `settledBy` (`run_ended`, `timeout` or `pending_request`)
and, for a pending request, `pendingRequests` in the shape
`t3_pending_request` `list` returns. Callers without the flag see no change.
Clients detect it by the field in the tool's `tools/list` input schema.
Code: `apps/server/src/orchestration-v2/ThreadManagementService.ts`
(`waitForThread`).

## FirstMate's sign-in lasts 10 years

Upstream gives every MCP sign-in a 30-day pass, most likely so a leaked or
forgotten pass does not stay valid forever. Here the pass for the client named
`firstmate` lasts 10 years when its sign-in redirects to loopback (`127.0.0.1`,
`localhost` or `[::1]`); every other client stays at 30 days. Anything able to
read that pass on this machine already runs as the owner and could mint a new
one, and a pass can still be revoked, so the short life added little and a
renewal job was more machinery than it saved. The loopback condition is needed
because the name is only the `client_name` a client registers with, and cloud
apps now sign in through a public URL, so any of them could claim it. FirstMate
signs in locally, so nothing changes for it. Code:
`apps/server/src/auth/EnvironmentAuth.ts` (`FIRSTMATE_SESSION_TTL`) and
`isLoopbackRedirect` in `McpOAuth.ts`.

## Messages record which client sent them

Every user message records the client that sent it, so an outside reader can
count prompts from the phone against the computer without parsing text. This
extends upstream's existing origin stamping: v1 events carried
`metadata_json.origin` `{ surface, appVersion }`, and the v2 orchestrator
dropped it. Here the server stamps `origin: { surface, deviceType, appVersion }`
on the message (`orchestration_v2_projection_messages.payload_json`) and on its
`message.updated` event's `metadata_json`. `surface` comes from the sending
socket (`desktop`, `mobile`, `web`), `deviceType` from that socket's auth
session (`desktop`, `mobile`, `tablet`, `bot`, `unknown`), so a phone browser
reads `web` + `mobile`. Messages sent through T3's MCP tools (FirstMate's
sends and launch briefs, the `t3 thread` CLI) read `surface: "mcp"`,
`deviceType: "bot"`. A client cannot set its own origin, nor upstream's
`linkedSender` label, which only a linked environment's relayed send may carry
(upstream lets a client set it; the fork drops it with `origin`). Server-made messages
(scheduled tasks, continuations) and messages from before this change have
none, which means unknown; nothing is backfilled. A run's sender is its
`userMessageId`'s origin. Code: `withCreationProvenance` in
`apps/server/src/orchestration-v2/ThreadManagementService.ts`, `messageProvenance`
in `Orchestrator.ts`, `clientOrigin` in `apps/server/src/ws.ts`.

## Work records the prompt that caused it

An MCP-sent message is stamped `mcp`/`bot`, which says an agent sent it but
not why. So FirstMate can tie a worker back to the phone or computer prompt
it acted on, `t3_thread_launch` and `t3_thread_send` take an optional
`causedBy`:

```json
"causedBy": { "threadId": "<thread>", "runId": "<run, optional>", "messageId": "<message>" }
```

- The server checks it before doing anything: the thread exists and is not
  deleted, the message is a user-role message (a prompt) in that thread, and,
  when `runId` is given, the message belongs to that run. Any thread an MCP
  caller may read is allowed, in any project. A failure is `invalid_request`
  with a `causedBy: ...` message, and nothing is launched or sent.
- `t3_thread_launch` stores it on the new thread (`thread.causedBy`) and on
  its first message when it has one. That first message travels inside
  upstream's `thread.create` `initialMessage`, which carries `causedBy` and
  `origin` for the fork; a new per-message field needs adding there too.
  `t3_thread_send` stores it on the sent
  message, through queueing and steering. Both are event-sourced:
  `thread.created` and `message.updated` payloads carry it.
- `t3_thread_read` returns the thread's in `thread.causedBy` and each
  message's on its `user_message` items. Absent means none was recorded;
  T3 never infers one. Linked servers without this omit both.
- Only server code sets it: a client's `thread.create` or `message.dispatch`
  loses any `causedBy` it carries. It refers to this environment only, so a
  call forwarded to a linked environment goes without it and the work there
  records no cause.
  `t3_thread_send_attachments` and `delegate_task` do not take it (delegated
  tasks already record their parent run).
- `t3_restart_request` and `t3_usage_claim` take the same checked `causedBy`:
  a restart's note and continuations count to it, and a claimed session,
  folder or turn counts to it.

Usage follows these links ([Usage by origin](#usage-by-origin)). Code:
`verifyCause` in `apps/server/src/mcp/threadAccess.ts`, `OrchestrationV2CausedBy`
in `packages/contracts/src/orchestrationV2.ts`.

## Queued messages can be stashed

![A held queued message with three images and a file; the bookmark beside Send now and the pencil reads "Move to the stash, with its attachments"](media/queued-stash.png)

A bookmark button on each queued message, held by Stop or a pending restart or not
held at all, moves it into the prompt
stash with all its images and files and cancels its run. The client downloads
each attachment from the server, stores the bytes, writes the stash entry, then
cancels; a failed download or write leaves the message queued, and a refused
cancel undoes the entry (and any eviction it caused). Guest messages have no
stash, like they have no edit. Web and desktop only: mobile has no prompt stash.

Upstream keeps stashed images as data URLs inside the localStorage entry, shrunk
to fit a per-entry budget, and drops any that still do not fit, keeping only the
name. Here every stash entry keeps image bytes (and a queued message's file
bytes) in IndexedDB, keyed by entry id, with no budget or recompression; the
entry holds only `media` metadata. Composer files are still stashed as pending
upload references. The entry is written only after its bytes are, so a refused
write stashes nothing; the async "saving N images" step and
`finalizeEntryImages` are gone. Entries saved the old way still restore. Stash
menu rows read context chips by their label rather than their link markup. Code:
`apps/web/src/promptStashMedia.ts`, `stashQueuedMessage` in
`apps/web/src/components/chat/promptStashActions.ts`, and the Stash button in
`QueuedRunsControl.tsx`. On syncs, upstream changes to `compressImageForStash`
or the stash entry schema need merging onto this model. Upstream fixes to its
async step (`finalizeEntryImages`, `pendingImageCount`, orphaned counts after a
reload, cross-tab finalize) have nothing to land on here and are dropped.

## Telemetry off by default

The fork sends no product analytics and no T3 Connect relay traces unless you
opt in. `T3CODE_TELEMETRY_ENABLED` governs both and defaults to `false` here
(upstream defaults it to `true`): `AnalyticsService.ts` and
`isRelayTracingEnabled` in `packages/shared/src/otelEnvironment.ts`. To turn them
on, set `T3CODE_TELEMETRY_ENABLED=true` in the server's environment. The desktop
app starts its server before it reads your login shell, so a shell-profile
export does not reach an app opened from the Dock: run
`launchctl setenv T3CODE_TELEMETRY_ENABLED true` and restart the app, or start
the app from a terminal that has the variable set. Your own OpenTelemetry export
and the mobile app's crash reports have their own settings.

## Paths in a file open beside it first

A relative path written in a file you are reading, as a link or as inline code
(`scripts/run.md` in `data/demo/report.md`), opens the file beside it
(`data/demo/scripts/run.md`) when that exists, and the path from the project's
top folder (`scripts/run.md`) otherwise. When neither exists, the error view
lists both attempted paths. Paths starting with `./`, `../` or `~/`, absolute
paths, URLs, paths in a file at the project's top folder and paths in chat
messages resolve as before; the existing read rules still decide what may
open. Upstream resolves inline code that has a folder from the top folder
only, and links from the file's folder only.

The choice happens on click: `fallbackFilePath` on the link
(`apps/web/src/markdown-links.ts`), `pickMarkdownFileCandidate` in
`apps/web/src/markdownFileHostPath.ts` (one metadata call for both paths, which
also serves open in editor, copy and reveal), and `alsoTried` on the file
surface for the error view in `FilePreviewPanel.tsx`. Mobile's file viewer
already reads links from the file's folder, has no fallback, and does not make
inline code tappable. On syncs, keep `resolveInlineCodeFileLinkMeta` resolving
from the file's folder.

## FirstMate edits files in any project

Upstream's file panel edits only files inside the open thread's project
folder; any other file on the machine opens read-only, and the server refuses
to save it. The intent is that a link in one thread cannot change files in
another project. FirstMate's own thread is the captain's command center across
every project, so there a file outside its folder is editable and saves like a
project file. Only FirstMate's main thread gets this (a pinned coordinator
that is not crew, `isPrimaryCoordinator`); secondmates, crew and every other
thread keep upstream's rule. The save names its thread, but that is only a
hint: any client that can read threads can see FirstMate's thread id, so the
server also requires the session's terminal permission (`terminal:operate`)
alongside filesystem write. A session with a shell can already change any
file, so that permission is what really authorizes the write; a pairing scoped
to filesystem write without terminal access keeps upstream's rule, and the
file panel opens host files read-only for it. The server writes in place only
a file that already exists, outside Git folders and the server's own state;
truncated reads and attachments stay read-only, and mobile does not edit
files. Code: `hostFileThreadId` in
`apps/web/src/components/files/FilePreviewPanel.tsx`, the `threadId` save
field in `ProjectWriteFileInput`, the `projects.writeFile` handler in
`apps/server/src/ws.ts`, and `resolveHostWriteTarget` in
`apps/server/src/workspace/WorkspaceFileSystem.ts`.

## Live Markdown editor

![A report open in the file panel as a rendered page, with the caret inside bold text whose two asterisk marks show dimmed](media/live-markdown.png)

A Markdown file that can be edited opens in the file panel as a rendered page
you type into, like Obsidian's Live Preview. Markdown marks show, dimmed, only
where the caret is; the rest stays drawn. The editor holds the file's exact
text and never converts it, so nothing an agent wrote is reformatted on save,
line endings included; a file that mixes line endings is saved with the one it
uses most once you edit it. Upstream offers a read-only rendered view or a source
editor, and opens Markdown as source.

It draws headings, bold, italic, strikethrough, inline code, quotes, callouts,
rules, lists and task boxes, code blocks with colours, tables, images from the
project, links, and frontmatter as a properties card. Mermaid, maths,
footnotes and raw HTML show as their source. A table, and the properties
card, turn into their Markdown while the caret is in them. A line break in
the file stays a line break, so a paragraph wrapped at 80 columns keeps its
short lines.

- The toolbar button still switches to upstream's source editor. Markdown
  opens rendered first (`t3code.renderMarkdown` now defaults to `true`).
- Saving is upstream's: the same save session and the same dot on the tab.
- A change on disk, such as an agent's edit, is applied line by line and
  stays out of the undo history. The caret, the scroll position and undo
  stay, and the changed lines are tinted for two seconds.
- A plain click follows a link: a file opens in the panel, a web address in
  the browser. Option-click puts the caret in the link. `[[wiki-links]]` are
  drawn but do not open. A link to a line (`report.md:42`) scrolls to it
  here; the read-only view still switches to source for that.
- A "Fork editor" badge sits in the file panel's toolbar while the editor
  shows, so it is never mistaken for upstream's read-only preview. Upstream's
  own views (the rendered view, the source editor, other files) carry none.
- Where the panel is at least 560 px wide, the outline is pinned in a column
  left of the page: headings nested by level, kept current as you type, the
  section being read marked (the caret's while it is on screen, otherwise the
  one at the top), a click jumps. The outline button shows or hides the column
  and the choice is remembered (`t3code.markdownOutlinePinned`, on by
  default). The column is on the left because the file explorer already sits
  on the right. A narrower panel, the read-only view and a phone keep the
  outline button's list. Cmd+F finds and replaces. A section or a block folds
  from the chevron beside it.

![The live editor with the Fork editor badge in the toolbar and the outline pinned left of the page, the section on screen marked](media/live-markdown-outline.png)

- Keys: Cmd+I italic, Cmd+E inline code, Cmd+Option+X strikethrough, Cmd+L
  toggles a task, Tab nests a list item. Cmd+B bolds only selected text, as
  in the message box; with a bare caret it stays the sidebar toggle.
  Strikethrough avoids Cmd+Shift+X, which is the workspace picker.
- A file that cannot be edited (a read-only connection, a file outside the
  project, a read cut off at 1 MB) and a phone (a narrow window or a touch
  pointer) keep upstream's rendered view, which gains the properties card
  and the outline button.

It is CodeMirror 6 (MIT) with a decoration layer of the fork's own, in a
chunk fetched when a Markdown file first opens this way. Code:
`apps/web/src/components/files/liveMarkdown/`, one file per feature, all
registered in `liveMarkdownEditor.ts`. `LiveMarkdownSurface.tsx` connects the
editor to T3's save path, signed image URLs and link opening.

Shared files it touches, for syncs: in `FilePreviewPanel.tsx` the lazy
import, the `liveMarkdown` flag and the branch that mounts the editor, the
`renderMarkdown` line (a linked line no longer forces source while the editor
shows), the default of `t3code.renderMarkdown`, the outline button with its
ref and column state (`useOutlineColumn`), and the badge; the properties card in `FileMarkdownPreview.tsx`; the selector in
`AppSidebarLayout.tsx` that lets Cmd+B bold a selection; the
`markdownFrontmatterLength` export in
`packages/shared/src/markdownFrontmatter.ts`, whose rule that a leading `---`
block with a blank line and no `key:` line is Markdown, not frontmatter, also
reaches upstream's rendered views on web and mobile through
`maskMarkdownFrontmatter`; the
`githubHeadingSlug` export in `apps/web/src/components/chat/markdownFragments.ts`,
which the outline uses for heading anchors; the pre-bundled packages in
`apps/web/vite.config.ts`; the `@codemirror/*` and `@lezer/*` entries in
`apps/web/package.json`; and a section in `docs/user/composer.md`. If
upstream ships its own editable rendered view, choose one of the two. The
mobile app is otherwise unchanged.

## Version

The fork keeps upstream's version number. The desktop app sets up an SSH or
WSL remote by downloading upstream's `t3` release for its own version
(`apps/desktop/src/main.ts`), so a version upstream never released, such as
`0.1.5-fork.1`, has nothing to download. The app name, bundle id and
data folder tell the fork apart. A sync to an upstream nightly keeps the stable
version its source carries (upstream stamps nightly versions only when it
builds): a `-nightly.` version would turn the build into upstream's "T3 Code
(Nightly)", with its icons and update track. A sync to a stable tag stamps that
tag's version the way upstream's release does,
`node scripts/update-release-package-versions.ts <version>`, because the tag's
source still carries the previous release; left at it, the build would announce
the very release it contains.

## Build

```sh
node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64
```

The build is unsigned, so electron-builder ad-hoc signs it. It writes
`release/T3-Code-<version>-arm64.dmg` and a `.zip`. Leave
`T3CODE_DESKTOP_UPDATE_REPOSITORY` and `GITHUB_REPOSITORY` unset. With neither
set, the app has no update feed and cannot update itself into the official
app.
Settings → About → Update track (Stable or Nightly, from upstream 0.1.5) then
only saves the track for this app, which says to reinstall it yourself. It
still moves connected machines that run upstream's `t3` to that track.
