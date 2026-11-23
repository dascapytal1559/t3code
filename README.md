## About this fork

This fork and [the FirstMate fork](https://github.com/dascapytal1559/firstmate) ship together as one bundle: use both.

A fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code), built to host the FirstMate fork and its crew.

Every difference from upstream, in the order [fork/README.md](fork/README.md) describes them. A feature with a second half in the FirstMate fork links to it from its section.

- [Its own app](fork/README.md#its-own-app): T3 Code (Fork) runs beside the official app, with its own data.
- [6 and 12 months](fork/README.md#6-and-12-months): the Usage page reaches back 6 and 12 months, drawn as stacked bars.
- [Mute a provider](fork/README.md#mute-a-provider): click a provider on the Usage page to leave it out of every figure.
- [Figures that read](fork/README.md#figures-that-read): Usage figures sit in columns and fade by size; the big ones stand out.
- [Breakdown boxes and the chart split](fork/README.md#breakdown-boxes-and-the-chart-split): five boxes beside the Usage chart, by provider, kind of work, device, process and direction; the open one splits the chart.
- [Accounts in your order](fork/README.md#accounts-in-your-order): usage lists accounts in the Settings › Providers order.
- [Limits in the sidebar](fork/README.md#limits-in-the-sidebar): one bar per account shows what is left this week, with a pace mark.
- [Archived usage](fork/README.md#archived-usage): usage counts machines and accounts that no longer run T3.
- [Phone vs computer split](fork/README.md#phone-vs-computer-split): tokens and cost split by phone or computer, typed or started by an agent.
- [Kinds of work](fork/README.md#kinds-of-work): usage split into groups of projects and folders you name; a shared group spreads over the rest.
- [Usage export](fork/README.md#usage-export): `t3 usage export` prints each model call as T3 counted it, as JSON lines.
- [Chart annotations](fork/README.md#chart-annotations): dated notes from a local file show on the Usage chart, with an on/off button.
- [Banked resets on a Mac](fork/README.md#banked-resets-on-a-mac): Claude's banked resets show and can be redeemed on macOS, each on the rows it refills.
- [Limits stay current](fork/README.md#limits-stay-current): a fresh limits reading on every check, with its age shown.
- [Limits history](fork/README.md#limits-history): every limits reading is kept in a monthly log.
- [App-bundled tools](fork/README.md#app-bundled-tools): a CLI inside a macOS app is left for that app to update.
- [`~` in tool paths](fork/README.md#-in-tool-paths): a provider path starting with `~` works for every provider.
- [Agents kept alive](fork/README.md#agents-kept-alive): idle agents can be kept for good (a server setting).
- [Upstream release note](fork/README.md#upstream-release-note): the sidebar says when upstream ships a release.
- [Board](fork/README.md#board): a tab to sketch on screenshots and attach them to the chat.
- [Crew in the sidebar](fork/README.md#crew-in-the-sidebar): FirstMate and its workers as one tree, each card saying what the worker is doing.
- [The branching animation](fork/README.md#the-branching-animation): a worker's branch draws into the crew tree and folds back when it is cleaned up.
- [Reply box goes to FirstMate](fork/README.md#reply-box-goes-to-firstmate): typing on a worker's thread reaches FirstMate, not the worker.
- [Settle, never archive](fork/README.md#settle-never-archive): menus offer Settle and no Archive, Snoozed stays pinned, and settling a worker tells FirstMate.
- [Indefinite snooze](fork/README.md#indefinite-snooze): snooze with no return time, first in every snooze menu.
- [Quiet workers, quiet wakes](fork/README.md#quiet-workers-quiet-wakes): only your own threads alert, and FirstMate's only when it needs you.
- [Tidy instruction line](fork/README.md#tidy-instruction-line): FirstMate's instruction line shows as "FirstMate · New instruction".
- [A fresh start really ends the old one](fork/README.md#a-fresh-start-really-ends-the-old-one): `/clear` on FirstMate stops the old session even when busy.
- [Auto clearing (cold clear)](fork/README.md#auto-clearing-cold-clear): FirstMate starts fresh once its cache expires; any project can opt in.
- [Lean Claude startup](fork/README.md#lean-claude-startup): a project can start Claude with only T3's and its folder's MCP servers, for a smaller first request.
- [Folder MCP servers on Antigravity](fork/README.md#folder-mcp-servers-on-antigravity): an Antigravity thread gets its folder's `.mcp.json` servers, as Claude does.
- [T3's tools say what they are](fork/README.md#t3s-tools-say-what-they-are): Codex sees a description of T3's MCP tools, so agents use them instead of clicking T3's window.
- [macOS Automation for agents](fork/README.md#macos-automation-for-agents): agents can use Codex Computer Use and raise macOS Automation prompts, from open upstream PR #33869 until upstream ships an equivalent.
- [Bridge](fork/README.md#bridge): your objectives and FirstMate's model routing, in a side-panel tab.
- [Clean restarts](fork/README.md#clean-restarts): a restart waits for running turns and holds new messages until after it.
- [One-line cards](fork/README.md#one-line-cards): each thread is one line: project icon, title, status; accounts numbered 1, 2, 3.
- [Agent names on cards](fork/README.md#agent-names-on-cards): a standing agent's threads show its name, such as a life log.
- [No repeated project name](fork/README.md#no-repeated-project-name): a card titled with its project's name drops the repeat.
- [Thread details hidden](fork/README.md#thread-details-hidden): new threads open without the details card; a setting shows it.
- [Context ring](fork/README.md#context-ring): the ring for how full a thread's context is stays in the message box.
- [Window grows for the panel](fork/README.md#window-grows-for-the-panel): opening the side panel widens the desktop window, so the chat keeps its width.
- [Clean session close](fork/README.md#clean-session-close): a closed Claude session waits for its process to exit, so FirstMate's next one keeps its lock.
- [Any agent as a worker](fork/README.md#any-agent-as-a-worker): each launched worker gets its own environment and instructions, on any provider.
- [FirstMate answers approvals](fork/README.md#firstmate-answers-approvals): FirstMate can allow or deny a worker's permission prompt.
- [Stopped turns close approvals](fork/README.md#stopped-turns-close-approvals): a stopped turn's approval prompts close instead of hanging.
- [Approvals reach FirstMate at once](fork/README.md#approvals-reach-firstmate-at-once): FirstMate hears a worker's question or approval the moment it appears.
- [FirstMate's marks stay first](fork/README.md#firstmates-marks-stay-first): FirstMate's wakes and doorbells reach its agent without T3's sender note in front.
- [Long sign-in](fork/README.md#long-sign-in): FirstMate's sign-in lasts 10 years instead of 30 days.
- [Which device sent it](fork/README.md#which-device-sent-it): every message records whether it came from the phone, the computer or an agent.
- [Work records its cause](fork/README.md#work-records-its-cause): each worker records which of your prompts started it.
- [Stash a queued message](fork/README.md#stash-a-queued-message): move a queued message into the stash with its images and files.
- [Telemetry off](fork/README.md#telemetry-off): nothing is sent unless you opt in.
- [Links that work](fork/README.md#links-that-work): a path in a Markdown file opens from that file's folder; headings and lines open; media plays.
- [FirstMate edits any file](fork/README.md#firstmate-edits-any-file): FirstMate's thread edits files outside its own project.
- [Live Markdown editor](fork/README.md#live-markdown-editor): a Markdown file opens as a rendered page you type into, like Obsidian.
- [Cite from a Markdown file](fork/README.md#cite-from-a-markdown-file): select text in a Markdown file and Cite it into the chat.
- [Citation chips](fork/README.md#citation-chips): a citation without a comment looks muted and goes in one click.
- [File tabs name their folder](fork/README.md#file-tabs-name-their-folder): `reports/README.md`, so same-named files tell apart.
- [Closing a tab goes back](fork/README.md#closing-a-tab-goes-back): closing a side-panel tab shows the tab you viewed before it.
- [Mouse Back and Forward do nothing](fork/README.md#mouse-back-and-forward-do-nothing): the mouse thumb buttons take no action in the app, so they stay free for your own bindings.

Details and pictures: [fork/README.md](fork/README.md).

<p align="center">
  <a href="https://t3.codes">
    <img src="./assets/prod/t3-black-web-icon-192x192.png" width="80" height="80" alt="T3 Code logo" />
  </a>
</p>

<h1 align="center">T3 Code</h1>

<p align="center">The open-source control plane for coding agents.</p>

<p align="center">
  <a href="https://t3.codes/download"><strong>Download</strong></a> ·
  <a href="https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824">iOS</a> ·
  <a href="https://play.google.com/store/apps/details?id=com.t3tools.t3code">Android</a> ·
  <a href="https://app.t3.codes">Web</a> ·
  <a href="./docs/README.md">Docs</a> ·
  <a href="https://discord.gg/jn4EGJjrvv">Discord</a>
</p>

<p align="center">
  <a href="https://t3.codes">
    <img src="./.github/readme/hero.webp" width="100%" alt="T3 Code on desktop with a finished Claude thread, next to the phone app asking to approve a command from Codex" />
  </a>
</p>

T3 Code runs the coding agents on your machine and gives them one fast interface. Start a thread at your desk, then approve the next step from your phone.

It works with Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, Muse Code, fx, and any [ACP](./docs/user/providers-acp.md) agent. If an agent is set up on your computer, T3 Code can control it.

## What you get

- **Your subscriptions.** T3 Code does not resell tokens. It drives the agents you are already signed in to.
- **Every agent in one place.** Change models in the middle of a thread. Let Claude hand a task to Codex.
- **Desktop, web, and phone.** One server, and every client shows the same threads. There are apps for iOS and Android.
- **Remote ready.** Run agents on any machine. Connect over your local network, Tailscale, or [T3 Connect](./docs/user/remote-access.md).
- **Git built in.** Each thread can work in its own worktree. Review the diff, then commit, push, and open a pull request with one button.
- **Fast.** Performance is a feature here. We measure it, and we treat a dropped frame as a bug.
- **Open.** MIT licensed. If you don't like something, fork it.

## Install

### Desktop app

[Download T3 Code](https://t3.codes/download) for macOS, Windows, or Linux. You can also use a package manager:

| Platform       | Command                                                              |
| -------------- | -------------------------------------------------------------------- |
| macOS          | `brew install --cask t3-code`                                        |
| Windows        | `winget install T3Tools.T3Code` or `scoop install extras/t3code`     |
| Arch Linux     | `yay -S t3code-bin`                                                  |
| Nix            | `nix profile add github:NixOS/nixpkgs/nixos-unstable#t3code`         |
| Debian, Ubuntu | `.deb` from [Releases](https://github.com/pingdotgg/t3code/releases) |

### Command line

This installs the `t3` command. Run `t3` to start the server and open the web app.

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

To try it once without an install, run `npx t3@latest`.

### Phone

Get the app from the [App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or [Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code). Then follow [remote access](./docs/user/remote-access.md) to connect it to your computer.

### Sign in to an agent

T3 Code needs one agent that is installed and signed in. For example, install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`, or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`.

[Provider setup](./docs/user/install.md#providers) has the steps for each agent. [Install T3 Code](./docs/user/install.md) covers nightly builds, AppImage, WSL, and NixOS.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the tool that you want.

## Documentation

- [Install and first run](./docs/user/install.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Source control](./docs/user/source-control.md)
- [Connect outside agents over MCP](./docs/user/outside-agents.md)
- [FAQ](./docs/user/faq.md)

[All docs](./docs/README.md) has the full list.

## Contributing

We have limited review capacity. Small, focused fixes are the most likely to be merged. Features need an approved discussion first.

- Read [CONTRIBUTING.md](./CONTRIBUTING.md) before you report a bug or open a pull request.
- Put feature requests in [Ideas](https://github.com/pingdotgg/t3code/discussions/categories/ideas).
- Build from source with the [development runbook](./docs/operations/development.md#first-checkout). The [architecture overview](./docs/internals/overview.md) explains how it works.
- Get help in [Discord](https://discord.gg/jn4EGJjrvv).

## License

[MIT](./LICENSE)
