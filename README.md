## About this fork

This fork and [the FirstMate fork](https://github.com/dascapytal1559/firstmate) ship together as one bundle: use both.

A fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code), built to host the FirstMate fork and its crew.

For FirstMate:

- [Crew sidebar](fork/README.md#firstmate-crew-in-the-sidebar): FirstMate and its workers as a tree, with short status labels.
- [No worker composer](fork/README.md#a-crewmate-has-no-composer): a worker thread has no message box, only Stop while it runs and the box back while it asks you something.
- [Approvals over MCP](fork/README.md#agents-answer-approvals-over-mcp): FirstMate answers a worker's permission prompts.
- [Waits end on a question](fork/README.md#waits-end-on-a-question-or-approval): FirstMate hears a question or approval the moment it appears.
- [Per-thread settings](fork/README.md#per-thread-environment-and-instructions): each launched worker gets its own environment and instructions.
- [Idle agents](fork/README.md#idle-agent-release-is-a-server-setting): idle release is a setting, and agents can be kept for good.
- [Mark read](fork/README.md#mcp-can-mark-a-thread-read): FirstMate clears a worker's Done card without opening the app.
- [Long sign-in](fork/README.md#firstmates-sign-in-lasts-10-years): FirstMate's sign-in lasts 10 years instead of 30 days, so it never needs renewing.
- [Bridge](fork/README.md#bridge): FirstMate's objectives, then each call it needs from you, in the right panel's Bridge tab.
- [Clean session close](fork/README.md#a-closed-claude-session-waits-for-its-cli-to-exit): a closed Claude session waits for its CLI to exit, so FirstMate's next one keeps its lock.

Also:

- [Its own app](fork/README.md#desktop-identity): T3 Code (Fork) runs beside the official one.
- [Telemetry off](fork/README.md#telemetry-off-by-default): nothing is sent unless you opt in.
- [Board](fork/README.md#board): a tab to sketch on screenshots and attach them to the chat.
- [Twelve months of usage](fork/README.md#usage-reaches-twelve-months): longer periods, drawn as stacked bars.
- [Muted usage rows](fork/README.md#usage-rows-can-be-muted): click a provider on the Usage page to mute it.
- [Usage in the sidebar](fork/README.md#usage-limits-in-the-sidebar): one bar per provider shows what is left this week.
- [Archived usage](fork/README.md#archived-usage): counts machines that no longer run T3.
- [Upstream release note](fork/README.md#upstream-release-indicator): the sidebar says when upstream ships a release.
- [App-bundled CLIs](fork/README.md#app-bundled-clis-are-updated-by-their-app): a CLI inside a macOS app is left for that app to update.
- [`~` in provider paths](fork/README.md#-in-a-providers-executable-path): works for every provider.
- [Stopped turns](fork/README.md#stopped-turns-close-their-approvals): their approvals close instead of staying pending.
- [Snooze with no date](fork/README.md#snooze-with-no-date): a thread waits on the Snoozed shelf until you wake it; FirstMate parks decisions older than a day there.
- [Two-line cards](fork/README.md#sidebar-cards-stay-two-lines): a lone PR badge no longer adds a third line.
- [Window grows for the panel](fork/README.md#the-window-grows-for-the-right-panel): opening the right panel widens the desktop window, so the chat keeps its width.

Details and pictures: [fork/README.md](fork/README.md).

# T3 Code

T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes) and [Electron-based desktop app](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, Google Antigravity, and fx. If they're set up on your computer, T3 Code can control them.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build, OpenCode, Antigravity, and fx. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.
> - fx: install [fx](https://fx.sh) and run `fx login` on the machine running the T3 Code server ([setup guide](./docs/user/providers-fx.md))

### Command line

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

Then run `t3` to start the server and open the local web app. `t3 service install` keeps it running in the background, `t3 update` moves to a newer release, and `t3 --help` has the full reference.

To try it once without installing, run `npx t3@latest` instead.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### Windows (`scoop`)

```bash
scoop install extras/t3code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Debian, Ubuntu (`.deb`)

Download the `.deb` from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), then:

```bash
sudo apt install ./T3-Code-*.deb
```

#### Arch Linux (AUR)

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

#### Nix (nixpkgs)

```bash
nix profile add github:NixOS/nixpkgs/nixos-unstable#t3code
```

The package is maintained in [nixpkgs](https://github.com/NixOS/nixpkgs/tree/nixos-unstable/pkgs/by-name/t3/t3code)
and includes the desktop app (`t3code-desktop`) and the `t3` command.
See [Nix installation](./docs/user/install.md#nix-nixpkgs) for NixOS configuration and updates.

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [FAQ](./docs/user/faq.md)
- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
