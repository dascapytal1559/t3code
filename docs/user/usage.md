# Usage and limits

Open **Usage** from the sidebar or the command palette, or press `mod+u` on web and
desktop when the terminal is not focused. Customize `usage.open` in
**Settings → Keybindings**.

On mobile, choose **Usage** in the workspace navigation.

## Understand your usage

**Usage** combines Codex, Claude Code, Grok Build, OpenCode, Antigravity, Pi, Muse Code, and Cursor history
from your connected environments. It shows token use, cache savings, model breakdowns, and estimated API-equivalent
cost, split by token type and by speed. These estimates are not your subscription bill.
**Premium** is what Fast and Ultrafast requests cost above standard rates. Cost that cannot be
split, such as a provider-reported cost for a model without public rates, shows as **Other**.
Select a model under **Breakdown** to see its trend, cache hit rate, and cost per million tokens.

Totals depend on the history available on each server. Grok turns without a saved completed-turn
record are missing from the totals.
Text generation (thread titles, commit messages, PR text, branch names and review guides) is not in
the totals for Codex or Claude Code 2.0.63 and newer, because those runs save no session history.

The server keeps scanned usage history for 367 days by default, enough for the 12 months view.
Claude Code deletes its own transcripts after 30 days, so for older Claude usage this history is the
only record left. To change how long it is kept, set `usageHistoryRetentionDays` in
`<T3 home>/userdata/settings.json` to a number of days, or to `"unlimited"`. Lowering the value
prunes older history on the next refresh, and raising it again does not bring pruned history back.
While `settings.json` cannot be read, nothing is pruned.

OpenCode reads its SQLite database and older JSON history. Antigravity reads local conversation
databases, including T3-managed profiles. Set `OPENCODE_DATA_DIR` or `ANTIGRAVITY_DATA_DIR` on the
server to read a different data directory; comma-separated paths read multiple directories.

Cursor reads account usage from Cursor's API for the account you signed in with in T3 or set as
`CURSOR_API_KEY`. This includes headless T3 sessions and desktop usage across machines; the same
account counts once across connected environments. T3 does not estimate missing tokens from
conversation text.

Usage includes each configured account's history, including disabled accounts. Custom homes follow
the account's home setting or its `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, or `GROK_HOME` environment
variable. Pi reads `~/.pi/agent/sessions`, or the `sessions` directory under
`PI_CODING_AGENT_DIR`. Set `PI_CODING_AGENT_SESSION_DIR` to read a different session directory.
To include sessions saved through `--session-dir` or Pi's `sessionDir` setting, set this environment
variable to the same directory. Pi includes recorded tool and summary costs under `Tools/summaries`.
Muse Code reads native session history, including child sessions, from the home reported by the
configured Muse CLI. Its environment settings, including `XDG_DATA_HOME`, apply. Models without
known prices still contribute tokens and appear as unpriced; set custom prices to estimate their cost.
Use absolute paths or `~/` paths in the account's environment settings; relative environment paths
depend on each project's working directory and cannot be reliably discovered by Usage. Accounts
sharing a history directory count once.

The server saves its first hostname in `<T3 home>/usage-host-id`, so a recreated container keeps
its usage identity when T3 home is persisted. Set `T3CODE_HOST_ID` to choose the identity
explicitly.

When your app and server support different providers, usage totals may cover only the providers
your app understands. Update the app to include newly supported providers.

On web and desktop, use the environment dropdown to filter costs, tokens, and limits. All
environments are selected by default. The dropdown shows which environments are still scanning;
results appear as each one responds, and figures still updating are dimmed. Cursor shows its last
saved totals first, then updates them when Cursor's API responds.

If recent work is missing or a new model shows no cost, refresh to rescan session history and
update model pricing.

On web and desktop, the **By device** breakdown splits usage between **Phone** and **Computer**.
Each device splits into **Direct** (prompts you typed) and **Orchestrated** (prompts an agent sent
on behalf of one you typed). A run counts toward
the message that started it, until you type again while it runs. Work an agent launches, and a
scheduled task it creates, counts where the agent's turn counted at that moment. That work then
counts there until you type about it again: a message you type that reaches it, such as
a reply on a worker's box or a FirstMate message sent from a turn you typed, moves it to the
device you typed on. Settling, snoozing and approving are clicks and move nothing. Phone includes
tablets. Sessions an agent runs outside T3, such as a CLI run in its worktree, count with the
agent's turn. A coordinator's own turns that nobody typed, such as FirstMate's wakes and
background checks, count to the computer as upkeep unless FirstMate says what they were about.
Usage with no sign of the phone counts to the computer, including agent work with
no recorded cause. Usage from before T3 recorded the sending device (7 Nov 2026) and archived
history show as **Unlabelled**. To see how much of the computer's share is there only by default, and why, run
`t3 usage reasons`. Once usage is more than a day old, its origin is final: the server writes it
down within a day or two and reads it back from then on, so nothing done later changes it. To
write it down sooner, run `t3 usage close --through <time>` with the time's offset, such as
`2026-11-19T15:00:00+11:00` (at least 5 minutes ago); add `--dry-run` first to see what it would
write.

## Split the chart by provider, device, kind of work, process or type

Beside the chart on **Usage** are five breakdowns of the same window: **by provider**, **by
device**, **by kind of work**, **by process** and **by type**. One of them is open as a card, and the chart splits
its bars the same way; the others fold down to their colour bar. Click a folded bar to open it in
the chart. The card lists each part with its figure and share; the chart stacks its largest band over the window
on top, so every bar stacks the same way. Cost and Tokens work in every breakdown, and hovering a bar names
each band. On a phone the breakdowns sit under the chart. On mobile, choose **Provider**,
**Device**, **Kind of work** or **Process** under the period.

**By provider** lists each provider; click a provider's name to leave it out of the totals, and
again to bring it back.

**By device** shows **Phone** and **Computer**, by the origin described above. Click either to
open it into **Orchestrated** and **Direct**: work agents sent for a prompt typed there, and the
prompts typed there themselves. Only the opened device's band splits in the chart. A coordinator's
upkeep counts to the computer, direct or orchestrated by how its turn started. Usage from before T3
recorded the sending device (7 Nov 2026), archived history and usage from a server too old to label
it count as **Computer** · **Direct**.

**By process** shows what FirstMate was doing: **Journal** is filing your voice journals and the
work launched from a journal's items; **Routines** is the upkeep FirstMate launches for a routine,
such as the bedtime routine's tool updates and nightly reviews; **Direct** is everything else,
including FirstMate's own wakes and checks. A journal you type into FirstMate yourself still counts
to the device you typed on, as journal work. Usage from before FirstMate labelled its journals is
**Direct**.

**By kind of work** splits usage into groups you name in **Settings → Providers → Kinds of work**.
They start as Trading, Tooling and Projects with nothing in them. Groups are saved on the
environment, so every client sees the same ones. A group holds projects, folders, or both. Click a
group to open it into its projects and folders; each opens and closes on its own, and the page
remembers what you leave open.

**By type** splits tokens into input, cache reads, output and cache writes, and cost into what each
of those cost. Cost no category accounts for is **Other**.

### Choose what a kind of work opens into

In **Settings → Providers → Kinds of work**:

- **Members**, per group, lets the group open into its projects and folders. It is on unless you
  turn it off; a shared group never opens.
- **Shown**, per project or folder, gives it a row of its own when its group opens. A project you
  hide still counts to its group and keeps its colour in the bar and the chart.
- **Name members by** names them by **Project name** or by **Repository**, the repository's folder
  name. Two projects of one repository show as one.

### How usage finds its group

Each model call is placed by the folder its session ran in:

1. A **project** covers its folder and subfolders, and the same places in the repository's
   worktrees, wherever they live. A worktree T3 ran a thread in still counts after it is removed,
   and a no-mistakes review counts to the repository it reviewed.
2. A **folder** entry covers that folder and its subfolders only, not worktrees elsewhere. Type an
   absolute path on the environment's machine, or start it with `~/` for the server's home.
3. When several entries cover a call's folder, the **closest** wins: the one with the fewest
   folder levels between it and where the call ran. A folder entry wins a tie with a project. A
   project in no group still takes its own folder, so its usage is **Other**.
4. Older Claude and Codex history with no folder of its own is placed by its session's folder.
5. Usage no entry covers, or with no folder at all, is **Other**.

### Shared groups and sharing Other

Turn on **Shared** for a group whose work serves all the others, such as a coordinator. A shared
group gets no band. In each bar, its usage is split across the groups that are not shared, in
proportion to their own usage in that bar, so every bar and the total still add up and the ratio
between the other groups does not change. Tokens and cost are each split by their own measure. When
a bar has no usage in those groups, the window's proportions are used instead; when the window has
none either, the usage stays **Other**.

**Share Other** spreads usage in no group across the groups the same way, so the chart has no Other
band. It is off by default. The kind-of-work card names what was spread. Exported records keep
each call's own group in `group`.

### Example: a coordinator and its workers

A coordinator agent runs in its repository's main folder, `~/work/coordinator`, and plans work
for other projects. Its workers change the coordinator's own repository in worktrees under
`~/worktrees/`. To count the workers' changes as tooling, and spread the coordinator's own
planning across everything it plans, set:

- **Tooling**: the `coordinator` project, so worker worktrees count here.
- **Product**: the projects the coordinator plans for.
- **Coordination**: the folder `~/work/coordinator`, **Shared** on. Its folder entry and the
  project are equally close to the main folder, so the folder entry takes the coordinator's own
  sessions, while worktrees outside that folder stay with the project.

The same groups in `<T3 home>/userdata/settings.json`, with each project's id:

```json
{
  "usageWorkGroups": [
    { "name": "Tooling", "projectIds": ["<coordinator project id>"] },
    { "name": "Product", "projectIds": ["<app project id>", "<site project id>"] },
    { "name": "Coordination", "projectIds": [], "folders": ["~/work/coordinator"], "shared": true }
  ],
  "usageWorkShareOther": true
}
```

## Count agent sessions T3 does not run

A session-start hook makes every Claude, Codex, and Grok session on the server's machine register
itself in `<T3 home>/userdata/session-register` (the T3 home is `~/.t3` unless you set
`T3CODE_HOME`). A session started by a T3 agent, such as a review or a child CLI run, then counts
to the turn its thread was running when it started, wherever it ran. If you move that agent's work
to your other device while the session runs, by typing to it, the session's later usage moves too.
A session started with no T3
thread or FirstMate task behind it, such as one you start in a terminal, counts to **Computer**.
Sessions T3 runs itself are unaffected. Registration needs no running server and never delays or
fails a session.

The hook is `apps/server/scripts/session-register-hook.sh` in the T3 Code source. It takes the
tool's name and the register folder. In the examples, replace `<hook>` with its full path and
`<register>` with the folder, for example `$HOME/.t3/userdata/session-register`.

- **Claude Code:** add it to `~/.claude/settings.json`, and to the `settings.json` of each profile
  you run with `CLAUDE_CONFIG_DIR`:

  ```json
  {
    "hooks": {
      "SessionStart": [
        { "hooks": [{ "type": "command", "command": "<hook> claude <register>", "timeout": 5 }] }
      ]
    }
  }
  ```

- **Codex:** turn on `hooks = true` under `[features]` in `~/.codex/config.toml`, then add the
  same block to `~/.codex/hooks.json` with `codex` in place of `claude`. Codex may ask you to
  approve a new hook before it runs.
- **Grok:** Grok also runs the hooks in `~/.claude/settings.json`, and the hook records those
  sessions as Grok's. If you skipped that file, save the same block with `grok` in place of
  `claude` as `~/.grok/hooks/t3-session-register.json`.

To check a tool, start a session in it and look for a new line in the register folder's file for
the current month.

## Set custom model prices

On web or desktop, open the environment dropdown on **Usage**, then choose **Model prices** to add,
edit, or reset a model's estimated price. **Apply to** starts with your current Usage filter;
choose all environments or select individual destinations. Enter the exact model ID and USD
rates per million input and output tokens. You can enter any model ID, including models
without public pricing. When a model on **Usage** has no known price, select it under
**Breakdown** and choose **Set price** to open this table with that model added.

Cache read and cache write rates are optional and use the input rate when blank. Enter `0` for
tokens that are free. Saved prices replace automatic pricing for all of that environment's
history and are shared with clients connected to it. When environments have different prices,
cells show **Mixed**. Edit rates directly in the table, then choose **Save changes** to apply all
edited rows. Untouched cells keep each environment's rate. Select one environment to inspect its
prices. **Reset to automatic** marks a model's override for removal when you save; you can undo
it before saving.

To count one model as another, such as a preview model under its released name, enter the target
model ID under **Map to**. The mapped model no longer appears on **Usage**: its tokens and cost
move to the target model and use the target's price. Clear **Map to** or reset the row to show
the model on its own again.

Each destination reports whether the change saved. Offline or unavailable environments are
marked **Not saved**. Reconnect them and choose **Retry failed saves** to finish the same change
without writing again to environments that already saved. Changes are not queued after you close
the dialog.

## Show only some models

To count only some models, or to leave some out, add `usageModelFilter` to the server's
`settings.json` in its `userdata` directory, such as `~/.t3/userdata/settings.json`:

```json
{
  "usageModelFilter": {
    "include": [{ "provider": "claude", "model": "orbit-1" }, { "model": "orbit-2" }],
    "exclude": [{ "model": "drift-9" }]
  }
}
```

`include` keeps only the listed models and `exclude` leaves the listed models out. `provider` is
one of `claude`, `codex`, `cursor`, `grok`, `opencode`, `antigravity`, `pi`, or `muse`; omit it
to match a model ID from any provider. Use the model ID that Usage shows without **Map to**, such
as a provider-prefixed ID for Pi. Filters apply before **Map to**, so a model you leave out is not
counted under its mapped name. Usage applies each environment's own filter. Remove the setting to
show every model again.

If the setting is invalid, Usage ignores it and shows every model, and the next save of any other
setting removes it from `settings.json`.

## Track subscription limits

**Usage → Limits** pools every subscription account it can see per provider, so with several Codex
or Claude accounts across your enabled environments and hubs you read one number per window rather than a
list. Each window card shows how much of the pool is left and a bar with one segment per account,
kept in the same column across windows. Accounts are ordered by their next 5-hour refill, soonest
first. For an account with no weekly quota left, this is when its session becomes usable again.
The first available window is used when no account reports a 5-hour limit. A gap means the
account does not report that window. When the provider reports reset times, the card also says
when the next reset lands and how much it hands back. The hatched
part of a segment is what that reset restores. Tap a segment or account row for the account's plan,
where it is signed in, and its reset time. On web, you can hover too. Codex and Claude accounts
with banked reset credits show a ticket count and the **Use reset** action in the account details.
Claude resets are not available when the server runs on macOS, where Claude keeps its login in the
Keychain. On narrow screens, numbered rows below
the bar show each account's quota, countdown, and credits. Tap a row to open its details.

The same account signed in on more than one environment, or reported by a hub as well, counts once.
Filter with the environment dropdown to see what a single machine has.

When a Claude or Codex account has no overall weekly quota left, its pooled session contribution
shows 0% left. The next refill depends on both reset times: an exhausted session must also reset,
and a partly spent session may only regain its unused portion when the week resets. Missing or
stale reset times have no refill estimate; refresh Limits for a new reading. Claude's
model-specific weekly allowances keep their reported values.

Opening Limits checks the selected connected environments automatically. Each client waits at
least five minutes between automatic checks of an environment, including after a failed check.
If a window still looks stale, refresh Limits to re-check every provider and hub. Each provider
says how long ago its limits were read.

Pick `/usage-limits` from the composer's command menu, or send it as a message, to check the
current model's limits without leaving the conversation. The result opens above the composer and
closes when you dismiss it or send your next message. It uses the same snapshot as **Usage → Limits**, so it does not run the agent or refresh
anything. The command is offered only for providers that appear under **Usage → Limits**.

To keep them in view on web and desktop, turn on **Usage limits** in **Settings → Appearance → Thread details**, or right-click the thread details card.
The bottom of the thread details card then shows how much is left in each limit window of the
current provider account. Some windows, such as a weekly Opus limit, count only one model. Hover a
row to see when it resets and your pace. Turn on **Context window** to also show the thread's
context use against the model's limit. A tick on the bar marks where the provider compacts
automatically, when it reports that point.

OpenCode Go reports its session, weekly, and monthly allowance when OpenCode runs locally in
the environment. T3 cannot report limits for external OpenCode servers because their credentials
belong to the remote server. Limits need an OpenCode Go API key, or an OpenCode Console connected
in OpenCode with an API key. A Console browser sign-in alone does not report them. You can also add
your Go API key as `OPENCODE_API_KEY` in the OpenCode instance's **Environment variables**, then
refresh provider status. Cursor reports
its monthly allowance, including separate Auto and API usage, for `CURSOR_AUTH_TOKEN` when it is set,
otherwise for the account you signed in with in T3 or set as `CURSOR_API_KEY`.
Sign-in and API keys report limits only with Cursor's default API endpoint. If you configure a custom
Cursor endpoint, use an explicit `CURSOR_AUTH_TOKEN` for limits.

Grok reports the remaining subscription allowance and reset time for its current billing period
after signing in with `grok login`. Explicit `XAI_API_KEY` connections and custom authentication
or endpoint configurations do not report subscription limits.

Muse Code reports its session and weekly windows and its tier once the Muse CLI has run in a thread.
Until then it shows no limits. Readings are not kept across a server restart.

API-key accounts may not report subscription limits. This also applies to Claude connections
using a proxy through `ANTHROPIC_AUTH_TOKEN`.

## Connect a CLIProxyAPI hub

To see pooled accounts, open **Settings → Providers → Usage providers → Add hub**. Choose the
environment that will connect to the hub and enter its URL and management key.

The hub's Codex, Claude, xAI (shown as Grok) and Antigravity accounts appear under **Usage → Limits**;
accounts for other providers are not read. Codex accounts show banked reset credits; select an
account and choose **Use reset** to redeem one. No hub plugin is required.

This connection supplies usage information; configure
the provider separately to send agent requests through the hub. Remove the hub from the same
settings section when you no longer need it.

## Subscription usage widget

Add **Subscription usage** from your iOS or Android widget gallery to see remaining Codex and
Claude quotas. Tap it to open **Usage → Limits**; on Android this works while T3 is running in
the background, otherwise open the app from the launcher. On iOS, use **Edit Widget** to choose
Session, Weekly, or both for each provider. Reopen T3 to refresh expired readings.

## Keyboard shortcuts

On web and desktop, open Usage from the command palette. While on Usage,
press `C`, `T`, or `L` for Cost, Tokens, or Limits while not typing in a field.
Use `Ctrl+Shift+1` through `Ctrl+Shift+6` (`Cmd+Shift+1`–`6` on macOS) for the past
24 hours, 7 days, 30 days, 90 days, 6 months, or 12 months. Period shortcuts do nothing on Limits.
Press `Escape` to return to the previous page. Customize these shortcuts in
**Settings → Keybindings**.
