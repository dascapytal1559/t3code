// Fork: file-based overrides under ~/.t3/fork that let a deploy swap what the
// desktop app runs without a DMG rebuild. See FORK_FEATURES.md ("Desktop runs
// a swappable server payload", "SSH launch runs the fork server").
// @effect-diagnostics-next-line nodeBuiltinImport:off - the server-root override must be checked synchronously pre-ready (see readDesktopServerRootOverride).
import * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { parseRemoteT3CliPackageSpecOverride } from "@t3tools/ssh/command";

export const desktopServerRootOverridePath = (homeDirectory: string): string =>
  `${homeDirectory}/.t3/fork/current`;

export const sshPackageSpecOverridePath = (homeDirectory: string): string =>
  `${homeDirectory}/.t3/fork/ssh-t3-package-spec`;

/**
 * Desktop server payload override. When `~/.t3/fork/current` — a symlink the
 * deploy scripts retarget at a staged build — contains apps/server/dist/bin.mjs
 * (plus the node_modules it resolves against), packaged builds load the
 * backend, and the web client it serves, from there instead of the copy baked
 * into app.asar. The symlink path is returned unresolved: it reaches the
 * backend supervisor as-is, and the supervisor respawns the backend child from
 * that same path whenever it exits, so a deploy is: retarget the symlink,
 * terminate the backend, reload the window. No app relaunch. Node resolves the
 * entry to its real path at spawn, so the outgoing backend keeps its own build
 * until it exits. A missing or invalid target falls back to the bundled tree.
 *
 * Checked synchronously: this runs while the DesktopEnvironment layer builds,
 * upstream of the Clerk bridge, which must be created before Electron's
 * "ready" event fires (it calls protocol.registerSchemesAsPrivileged). Async
 * I/O here would yield to the event loop and let "ready" win the race.
 */
export function readDesktopServerRootOverride(homeDirectory: string): string | null {
  const root = desktopServerRootOverridePath(homeDirectory);
  return NodeFS.existsSync(`${root}/apps/server/dist/bin.mjs`) ? root : null;
}

/**
 * SSH package spec override. When `~/.t3/fork/ssh-t3-package-spec` exists,
 * its first non-empty non-comment line is used verbatim as the npm package
 * spec for SSH-launched remote servers — for example the path of a fork-built
 * t3 tarball already copied onto the remote host. Read at every launch so a
 * new spec applies on the next reconnect. A missing or empty file yields null.
 */
export const readSshPackageSpecOverride = (
  homeDirectory: string,
): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
    fileSystem.readFileString(sshPackageSpecOverridePath(homeDirectory)).pipe(
      Effect.map(parseRemoteT3CliPackageSpecOverride),
      Effect.orElseSucceed((): string | null => null),
    ),
  );
