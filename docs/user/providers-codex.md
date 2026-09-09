# Codex

For one account, use the default Codex provider with your normal Codex login.
[Provider setup](./install.md#providers) covers installation, Settings > Providers,
and custom binaries or environment variables.

## Continue the same conversation in Codex and T3

Shared desktop mode lets both apps stay open and continue the same native
conversation between completed turns. Codex owns the backend; closing a T3
session only disconnects T3. Starting a task opens Codex if needed. If an existing
Codex instance uses incompatible launch settings, T3 asks you to restart it.

This mode currently targets macOS with one shared backend and one fixed account.
T3 clients on other devices can use that Mac's server. Leave shadow homes, custom
launch arguments and provider environment overrides empty. Switch accounts in
Codex itself.

Install the shared launcher from the T3 distribution. Supply the actual app,
Codex home and installation paths:

```bash
node /path/to/t3/dist/codex-shared-launcher.mjs install \
  --app "/Applications/ChatGPT.app" \
  --codex-home "$HOME/.codex" \
  --directory "$HOME/.t3/codex-shared" \
  --launch-agents "$HOME/Library/LaunchAgents"
```

Quit and reopen Codex. In **Settings > Providers > Codex**, set **Shared Codex app
launcher** to `~/.t3/codex-shared/codex-shared` and **CODEX_HOME path** to the home
used above. The shared launcher takes precedence over the ordinary binary path.
Leaving the shared launcher field empty uses the independent backend.

The installer preserves ordinary Dock and Finder launch through a per-user
`CODEX_CLI_PATH` setting and a login agent. Other future GUI programs that honor
that variable can see it. The signed Codex app stays unchanged.

Completed desktop turns are refreshed before T3 continues. Their messages and
native tool records are retained without creating T3 checkpoints. T3 refuses to
send into, or stop, an active turn owned by the other app. T3 rewind is unavailable
in shared mode; its turn counts do not yet account for intervening desktop turns.

Update Codex through its normal app updater. To restart the shared backend
manually:

```bash
"$HOME/.t3/codex-shared/codex-shared" shared-restart
```

This checks for active turns, quits the owning Codex instance, waits for backend
ownership to end, and reopens the app using its current bundled executable. It
also closes Codex windows. The stdio connection requires this app relaunch.
`shared-status` reports the current backend. There is no separate CLI update.

To remove shared mode, finish any work and quit Codex, then run:

```bash
"$HOME/.t3/codex-shared/codex-shared" shared-uninstall
```

Clear **Shared Codex app launcher** in T3 afterward. Removal restores the prior
login environment and the MCP configuration entry replaced by this integration.
Your conversations and other Codex settings remain in place.

## Use multiple accounts

A shared Codex home with a shadow home lets work and personal accounts continue
the same threads. The accounts share Codex sessions and configuration while keeping
their own login and available models.

Keep your first account in `~/.codex`. On the environment's machine, sign the
second account into a fresh directory:

```bash
mkdir -p ~/.codex_personal
CODEX_HOME=~/.codex_personal codex login
```

Then add a second Codex instance in **Settings > Providers**:

| Instance       | CODEX_HOME path | Shadow home path    |
| -------------- | --------------- | ------------------- |
| Codex Work     | `~/.codex`      | Leave empty         |
| Codex Personal | `~/.codex`      | `~/.codex_personal` |

Both instances must use the same **CODEX_HOME path**. T3 Code prepares the shared
state in the shadow directory; do not populate it by copying your whole Codex
home.

The shadow account needs its own `auth.json` file. If Codex uses an OS credential
store, configure file storage for this setup. See
[OpenAI's credential storage guide](https://learn.chatgpt.com/docs/auth#credential-storage).

Use a completely separate **CODEX_HOME path**, with no shadow home, when you want
separate Codex sessions and configuration. That instance cannot continue threads
from the other home.

## Switch accounts in an existing thread

Choose the other account from the thread's model picker. T3 Code offers compatible
Codex instances that share the thread's **CODEX_HOME path**. Changing accounts does
not move the conversation into a separate Codex home.

If the account is missing from the picker, compare the home paths in provider
settings. If two instances show the same unexpected account or models, check their
reported accounts, refresh provider status, and confirm the second instance has
its own shadow path and login. A shadow-home conflict usually means the directory
contains a copied Codex setup. Use a fresh shadow directory and sign in again.

## Answer questions while Codex works

Codex can ask a question and keep working. Answer it in the thread's question
panel. The answer becomes a new message: it reaches the active turn, or starts
another turn if Codex has finished. Unanswered questions survive reconnects.
If you do not want to answer, dismiss the question from its panel. Dismissing
closes it without sending anything to Codex. This requires a Codex version that
supports async questions.

## Approve app access

Codex tools can request access to another app. Respond to the named app's request
in the thread on web, desktop, or mobile. Some tools offer access for one request,
the current session, or permanently. See [Permission modes](./permission-modes.md)
for command and file approvals.

## Send feedback to OpenAI

In an existing Codex thread, send `/feedback` with an optional description, for
example `/feedback The agent stopped before finishing the tests`. This uploads
the conversation and Codex logs to OpenAI. The returned thread ID can be shared
with OpenAI support.

## Open a Codex app thread in T3 Code

A conversation started in the Codex app can be continued in T3 Code. Copy its
link from the Codex app (it looks like `codex://threads/<id>`), open the command
palette, and paste it. Choose **Import Codex thread**; with several connected
computers, pick the one whose Codex home holds the conversation. T3 Code adds
the project for the conversation's directory if it is not already there and
opens the thread with its history. A bare thread id works too.
