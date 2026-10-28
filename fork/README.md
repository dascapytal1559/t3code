# Fork changes

This fork tracks `pingdotgg/t3code` `main`. Keep this list current so each upstream
sync knows what to carry forward. Earlier fork work is archived on the local
branch `archive/fork-legacy-2026-10-19` and is out of scope for syncs; take
from it only on request.

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

Two things are still shared with the official app:

- The `t3code://` link scheme. Both apps register it, so macOS picks which app
  opens sign-in and prompt links.
- The default Tailscale Serve port, 443. Do not turn on Tailscale Serve in both
  apps at the same port.

## Usage reaches twelve months

The Usage page on web and desktop has 6 months (`Cmd+Shift+5`) and 12 months
(`Cmd+Shift+6`) periods, drawn as stacked daily bars. The mobile app still
stops at 90 days. The server keeps parsed usage for 367 days instead of 92, so
usage stays after Claude Code deletes old transcripts. History older than what
is on disk or in the saved usage today cannot be recovered; twelve months builds
up from when this build first scans.

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
  (the newest of `usage-scan-cache-v9.json` down to `usage-scan-cache.json`,
  version 3 on).
  Saved usage still has usage whose transcripts were deleted. Version 3 caches
  are priced at standard speed. OpenCode, Pi and Antigravity copies are not
  read.
- Archived usage is parsed and deduplicated like live history. Live
  directories are read first, so usage that is both live and archived counts
  once and stays credited to the live source. The archived part of the total
  is shown on the Usage page by host and instance.
- A remote that still runs T3 and is connected would be counted again next to
  its archive copy. Archive a host after T3 is removed from it.

## App-bundled CLIs are updated by their app

On macOS, a provider CLI whose real path is inside an app bundle
(`*.app/Contents/...`) is left to that app. An example is ChatGPT.app's Codex,
which `~/.local/bin/codex` links to. T3 shows no Update button for it and never
runs its updater. Without this, Codex offers an update that fails, because
`codex update` cannot update ChatGPT's copy and exits 1. This works like
upstream's handling of WinGet's Claude, in
`packages/provider-core/src/server/maintenanceResolver.ts`.

## Idle agent release is a setting (carried upstream PR)

This carries upstream https://github.com/pingdotgg/t3code/pull/25624 unchanged:
the server setting `providerSessionIdleTimeoutMinutes` (default 30, `null` is
Never) replaces the hardcoded 30-minute idle release, shown under Settings →
Threads → Agent memory. Firstmate's environment sets it to Never. When a sync
finds the PR merged, or an upstream equivalent, drop this copy and keep
upstream's.

## Version

The fork keeps upstream's version number. The desktop app sets up an SSH or
WSL remote by downloading upstream's `t3` release for its own version
(`apps/desktop/src/main.ts`), so a version upstream never released, such as
`0.1.4` or `0.1.3-fork.1`, has nothing to download. The app name, bundle id and
data folder tell the fork apart.

## Build

```sh
node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64
```

The build is unsigned, so electron-builder ad-hoc signs it. It writes
`release/T3-Code-<version>-arm64.dmg` and a `.zip`. Leave
`T3CODE_DESKTOP_UPDATE_REPOSITORY` and `GITHUB_REPOSITORY` unset. With neither
set, the app has no update feed and cannot update itself into the official
app.
