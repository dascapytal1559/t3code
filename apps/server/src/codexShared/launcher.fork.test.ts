// @effect-diagnostics nodeBuiltinImport:off
// Fork: Shared Codex desktop backend (FORK_FEATURES.md).
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { describe, expect, it } from "vite-plus/test";
import { acquireOwner, stopOwnedChild } from "./launcher.ts";
import { installSharedLauncher, uninstallSharedLauncher, type LaunchControl } from "./install.ts";
import type { SharedCodexConfig } from "./config.ts";

const configFor = (root: string): SharedCodexConfig => ({
  version: 1,
  appPath: root,
  binaryPath: "/unused",
  nodePath: process.execPath,
  codexHome: root,
  stateDirectory: NodePath.join(root, "state"),
  launcherPath: NodePath.join(root, "launcher"),
});

describe.skipIf(HostProcessPlatform.defaultValue() !== "darwin")(
  "shared launcher ownership",
  () => {
    it("retains the lease in the backend after its launcher descriptor closes", async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-shared-lease-"));
      const config = configFor(root);
      const lease = await acquireOwner(config);
      const child = NodeChildProcess.spawn(
        process.execPath,
        ["-e", "process.stdout.write('ready');process.stdin.resume()"],
        { stdio: ["pipe", "pipe", "pipe", lease.fd] },
      );
      try {
        await NodeEvents.EventEmitter.once(child.stdout!, "data");
        await expect(acquireOwner(config)).rejects.toThrow("Another Codex launcher");
        await lease.close();
        await expect(acquireOwner(config)).rejects.toThrow("Another Codex launcher");
        await stopOwnedChild(child);
        const replacement = await acquireOwner(config);
        await replacement.close();
      } finally {
        await stopOwnedChild(child);
        await lease.close();
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    });

    it.each([null, "/previous/codex", ""])(
      "restores the previous login environment (%s)",
      async (previous) => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-shared-install-"));
        let current = previous;
        const calls: readonly string[][] = [];
        const control: LaunchControl = async (args) => {
          (calls as string[][]).push([...args]);
          if (args[0] === "getenv")
            return { code: current === null ? 1 : 0, stdout: current ?? "" };
          if (args[0] === "setenv") current = args[2]!;
          if (args[0] === "unsetenv") current = null;
          return { code: 0, stdout: "" };
        };
        try {
          const appPath = NodePath.join(root, "Codex 'test'.app");
          await NodeFSP.mkdir(NodePath.join(appPath, "Contents/Resources/cua_node/bin"), {
            recursive: true,
          });
          await NodeFSP.writeFile(NodePath.join(appPath, "Contents/Resources/codex"), "");
          await NodeFSP.writeFile(
            NodePath.join(appPath, "Contents/Resources/cua_node/bin/node"),
            "",
          );
          const bundlePath = NodePath.join(root, "bundle.mjs");
          await NodeFSP.writeFile(bundlePath, "// isolated fixture");
          const directory = NodePath.join(root, "installed");
          const config = await installSharedLauncher(
            {
              appPath,
              codexHome: root,
              directory,
              launchAgentsDirectory: NodePath.join(root, "agents"),
              bundlePath,
            },
            control,
          );
          expect(current).toBe(config.launcherPath);
          const script = await NodeFSP.readFile(config.launcherPath, "utf8");
          expect(script).toContain("'\\''");
          const check = NodeChildProcess.spawn("/bin/sh", ["-n", config.launcherPath]);
          expect((await NodeEvents.EventEmitter.once(check, "exit"))[0]).toBe(0);
          const lease = await acquireOwner(config);
          await expect(
            uninstallSharedLauncher(NodePath.join(directory, "config.json"), control, 0),
          ).rejects.toThrow("Another Codex launcher");
          expect(current).toBe(config.launcherPath);
          await lease.close();
          await uninstallSharedLauncher(NodePath.join(directory, "config.json"), control, 0);
          expect(current).toBe(previous);
        } finally {
          await NodeFSP.rm(root, { recursive: true, force: true });
        }
      },
    );
  },
);
