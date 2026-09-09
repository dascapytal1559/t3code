# T3 fork and shared Codex setup

The fork source is the repository root, one level above this directory. The installed T3 desktop app loads its
server and web client from `~/.t3/fork/current`. Deployment procedures live in
[DEPLOY_FORK.md](DEPLOY_FORK.md).

## Shared conversations

Codex and T3 use one Codex backend owned by the Codex desktop app. Both apps can
stay open and continue the same native conversation between completed turns.
This avoids competing writers on the same conversation. Closing T3 disconnects
its client; the backend stays with Codex. T3 can request that Codex open when the
backend is absent. A Codex instance started with incompatible settings must be
quit and reopened.

This setup targets this Mac and one fixed Codex account. The paths are:

| Purpose                   | Path                                                 |
| ------------------------- | ---------------------------------------------------- |
| Codex app                 | `/Applications/ChatGPT.app`                          |
| Shared Codex home         | `~/.codex`                                           |
| Installed shared launcher | `~/.t3/codex-shared/codex-shared`                    |
| Login agent               | `~/Library/LaunchAgents/codes.t3.codex-shared.plist` |
| T3 server and web client  | `~/.t3/fork/current`                                 |

The launcher uses the native executable bundled with Codex. The installer sets
`CODEX_CLI_PATH` in the macOS login environment so ordinary Dock/Finder launch
uses it, and preserves the prior setting for uninstall. Other future GUI
programs that honor that variable can see it. The signed Codex app is unchanged.

In the normal T3 app, open **Settings > Providers > Codex** and set:

- **Shared Codex app launcher:** `/Users/zerongwang/.t3/codex-shared/codex-shared`
- **CODEX_HOME path:** `/Users/zerongwang/.codex`; leaving it unset uses the equivalent default `~/.codex`.
- Leave shadow home, custom launch arguments, and provider environment overrides empty.

Completed Codex turns appear in T3 without invented T3 checkpoints. T3 refuses
to send into or stop a turn owned by the other app. Rewind is unavailable in
shared mode. T3 preview automation requires a native T3 desktop window connected
to the environment; the browser-only T3 client does not host preview automation.

## Update and restart

Update Codex using its normal app updater, finish active turns, then run:

```sh
~/.t3/codex-shared/codex-shared shared-restart
```

The same command is available from this directory as:

```sh
./restart-codex-backend.sh
```

The command checks for active turns, quits the owning Codex app, and relaunches
it with the current bundled backend. Codex windows close during this operation.
There is no separate Codex CLI update for shared mode. T3 reconnects when a
conversation is continued.

Inspect backend status with:

```sh
~/.t3/codex-shared/codex-shared shared-status
```

## Remove shared mode

Finish active turns and quit Codex. Run:

```sh
~/.t3/codex-shared/codex-shared shared-uninstall
```

Clear **Shared Codex app launcher** in T3, then reopen Codex normally. Uninstall
restores the prior login setting and the T3 MCP configuration entry saved by the
integration. Existing conversations remain in the Codex home.

Installation details are in
[the Codex provider guide](../docs/user/providers-codex.md).

## Initial rollout

The tested payload is `~/.t3/fork/builds/shared-e6a0514ea86e`, selected by
`~/.t3/fork/current`. Quit and reopen the normal T3 app to load it. Quit and
reopen Codex through its ordinary Dock/Finder entry to activate the installed
launch setting, then configure the T3 provider fields above. Ordinary Codex launch was verified to start the shared backend against
`~/.codex`, and T3 was verified to load the selected payload. Sending a message
in the normal T3 installation with both apps open also passed. Automatic Codex
opening when it is closed still needs verification on this installation.

The previous T3 payload is retained at `~/.t3/fork/builds/9d153555b`. To revert
the T3 payload, quit T3 first, then run:

```sh
ln -sfh builds/9d153555b "$HOME/.t3/fork/current"
```

Reopen T3 afterward. This payload rollback is separate from removing Codex's
shared launch setting. The archive checksum and previous payload target are
recorded in [the rollout record](deploy/shared-codex-rollout.json).
