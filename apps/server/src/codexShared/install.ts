// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
// Standalone installer; all launch settings are explicit and reversible.
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import {
  readSharedConfig,
  SharedMcpBackup,
  sharedMcpBackupPath,
  type SharedCodexConfig,
} from "./config.ts";
import { withSharedRpc } from "./transport.ts";
import { acquireOwner, stopOwnedChild } from "./launcher.ts";

const Installation = Schema.Struct({
  previousCliPath: Schema.NullOr(Schema.String),
  launchAgentPath: Schema.String,
});
const decodeInstallation = Schema.decodeUnknownSync(Schema.fromJsonString(Installation));
const decodeMcpBackup = Schema.decodeUnknownSync(Schema.fromJsonString(SharedMcpBackup));
export type LaunchControl = (args: readonly string[]) => Promise<{ code: number; stdout: string }>;
export const launchControl: LaunchControl = async (args) => {
  const child = NodeChildProcess.spawn("/bin/launchctl", [...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (data) => {
    stdout += String(data);
  });
  child.stderr.resume();
  const [code] = await NodeEvents.EventEmitter.once(child, "exit");
  return { code: typeof code === "number" ? code : 1, stdout: stdout.replace(/\n$/, "") };
};
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const exists = async (path: string) => {
  try {
    await NodeFSP.access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
};

export async function installSharedLauncher(
  input: {
    appPath: string;
    codexHome: string;
    directory: string;
    launchAgentsDirectory: string;
    bundlePath: string;
  },
  control: LaunchControl = launchControl,
): Promise<SharedCodexConfig> {
  if (HostProcessPlatform.defaultValue() !== "darwin")
    throw new Error("Shared Codex installation currently requires macOS.");
  for (const value of Object.values(input))
    if (!value.startsWith("/")) throw new Error("Installation paths must be absolute.");
  const directory = NodePath.resolve(input.directory);
  const config: SharedCodexConfig = {
    version: 1,
    appPath: NodePath.resolve(input.appPath),
    binaryPath: NodePath.join(input.appPath, "Contents/Resources/codex"),
    nodePath: NodePath.join(input.appPath, "Contents/Resources/cua_node/bin/node"),
    codexHome: NodePath.resolve(input.codexHome),
    stateDirectory: NodePath.join(directory, "state"),
    launcherPath: NodePath.join(directory, "codex-shared"),
  };
  await NodeFSP.access(config.binaryPath);
  await NodeFSP.access(config.nodePath);
  const launchAgentPath = NodePath.join(input.launchAgentsDirectory, "codes.t3.codex-shared.plist");
  const installationPath = NodePath.join(directory, "installation.json");
  if ((await exists(directory)) || (await exists(launchAgentPath)))
    throw new Error(
      "Shared launch files already exist. Uninstall the existing installation before replacing it.",
    );
  const previous = await control(["getenv", "CODEX_CLI_PATH"]);
  const previousCliPath = previous.code === 0 ? previous.stdout : null;
  if (previousCliPath === config.launcherPath)
    throw new Error(
      "The login environment already refers to this launcher, but its installation record is missing.",
    );
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  await NodeFSP.mkdir(config.stateDirectory, { mode: 0o700 });
  await NodeFSP.mkdir(input.launchAgentsDirectory, { recursive: true });
  const bundlePath = NodePath.join(directory, "codex-shared-launcher.mjs");
  const configPath = NodePath.join(directory, "config.json");
  try {
    await NodeFSP.copyFile(input.bundlePath, bundlePath);
    await NodeFSP.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    await NodeFSP.writeFile(
      installationPath,
      JSON.stringify({ previousCliPath, launchAgentPath }) + "\n",
      {
        mode: 0o600,
      },
    );
    await NodeFSP.writeFile(
      config.launcherPath,
      `#!/bin/sh\nexec ${shellQuote(config.nodePath)} ${shellQuote(bundlePath)} --shared-config ${shellQuote(configPath)} "$@"\n`,
      { mode: 0o700 },
    );
    await NodeFSP.writeFile(
      launchAgentPath,
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>codes.t3.codex-shared</string><key>ProgramArguments</key><array><string>/bin/launchctl</string><string>setenv</string><string>CODEX_CLI_PATH</string><string>${xml(config.launcherPath)}</string></array><key>RunAtLoad</key><true/></dict></plist>\n`,
      { mode: 0o600 },
    );
    const result = await control(["setenv", "CODEX_CLI_PATH", config.launcherPath]);
    if (result.code !== 0) throw new Error("macOS refused the launch environment setting.");
    return config;
  } catch (error) {
    await control(
      previousCliPath === null
        ? ["unsetenv", "CODEX_CLI_PATH"]
        : ["setenv", "CODEX_CLI_PATH", previousCliPath],
    );
    await NodeFSP.rm(launchAgentPath, { force: true });
    await NodeFSP.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function restoreMcpConfiguration(config: SharedCodexConfig): Promise<void> {
  if (!(await exists(sharedMcpBackupPath(config)))) return;
  const backup = decodeMcpBackup(await NodeFSP.readFile(sharedMcpBackupPath(config), "utf8"));
  // The ownership lease is already held and the desktop is closed. This
  // administrative process edits config only; it never opens a conversation.
  const child = NodeChildProcess.spawn(
    config.binaryPath,
    ["app-server", "--listen", "ws://127.0.0.1:0"],
    {
      env: { ...process.env, CODEX_HOME: config.codexHome, CODEX_SQLITE_HOME: config.codexHome },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  try {
    const url = await new Promise<string>((resolveUrl, reject) => {
      let log = "";
      const timer = setTimeout(
        () => reject(new Error("Codex did not start to restore MCP configuration.")),
        10_000,
      );
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Codex exited before restoring MCP configuration."));
      });
      child.stderr.on("data", (data) => {
        log = (log + String(data)).slice(-16_000);
        const match = log.match(/listening on: (ws:\/\/127\.0\.0\.1:\d+)/);
        if (match) {
          clearTimeout(timer);
          resolveUrl(match[1]!);
        }
      });
    });
    await withSharedRpc(url, async (request) => {
      await request("config/value/write", {
        keyPath: "mcp_servers.t3-shared",
        mergeStrategy: "replace",
        value: backup.value,
      });
    });
    await NodeFSP.rm(sharedMcpBackupPath(config));
  } finally {
    await stopOwnedChild(child);
  }
}

export async function uninstallSharedLauncher(
  configPath: string,
  control: LaunchControl = launchControl,
  waitSeconds = 15,
): Promise<void> {
  const config = await readSharedConfig(configPath);
  const directory = NodePath.resolve(configPath, "..");
  const installation = decodeInstallation(
    await NodeFSP.readFile(NodePath.join(directory, "installation.json"), "utf8"),
  );
  const lease = await acquireOwner(config, waitSeconds);
  try {
    const current = await control(["getenv", "CODEX_CLI_PATH"]);
    if (current.code === 0 && current.stdout !== config.launcherPath)
      throw new Error(
        "CODEX_CLI_PATH changed after installation. Resolve that change before uninstalling.",
      );
    await restoreMcpConfiguration(config);
    await control(["bootout", `gui/${process.getuid!()}`, installation.launchAgentPath]);
    const restored = await control(
      installation.previousCliPath === null
        ? ["unsetenv", "CODEX_CLI_PATH"]
        : ["setenv", "CODEX_CLI_PATH", installation.previousCliPath],
    );
    if (restored.code !== 0) throw new Error("Could not restore the previous login environment.");
    await NodeFSP.rm(installation.launchAgentPath);
    for (const name of [
      "installation.json",
      "config.json",
      "codex-shared",
      "codex-shared-launcher.mjs",
    ])
      await NodeFSP.rm(NodePath.join(directory, name));
  } finally {
    await lease.close();
  }
  await NodeFSP.rm(NodePath.join(config.stateDirectory, "owner.lock"));
  for (const path of [config.stateDirectory, directory]) {
    try {
      await NodeFSP.rmdir(path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOTEMPTY")) throw error;
    }
  }
}
