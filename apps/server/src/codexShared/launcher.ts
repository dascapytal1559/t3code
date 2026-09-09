// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
// Standalone launch boundary: runs before T3 and owns native process pipes.
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import {
  readSharedConfig,
  readSharedState,
  sharedMcpBackupPath,
  sharedControlPath,
  sharedStatePath,
  type SharedCodexConfig,
  type SharedCodexState,
} from "./config.ts";
import { openWebSocket, relayStdio, withSharedRpc } from "./transport.ts";

export const SHARED_CLIENT_ENV = "T3_CODEX_SHARED_CLIENT";
export const SHARED_AUTOSTART_ENV = "T3_CODEX_SHARED_AUTOSTART";
const ControlRequest = Schema.Struct({
  token: Schema.String,
  command: Schema.Literals(["status", "check-idle"]),
});
const LoadedThreads = Schema.Struct({
  data: Schema.Array(Schema.String),
  nextCursor: Schema.NullOr(Schema.String),
});
const ThreadStatus = Schema.Struct({
  thread: Schema.Struct({ status: Schema.Struct({ type: Schema.String }) }),
});

const decodeControlReply = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ id: Schema.String, error: Schema.optionalKey(Schema.String) }),
  ),
);
const decodeControlRequest = Schema.decodeUnknownSync(Schema.fromJsonString(ControlRequest));
const decodeLoadedThreads = Schema.decodeUnknownSync(LoadedThreads);
const decodeThreadStatus = Schema.decodeUnknownSync(ThreadStatus);
const decodeMcpConfig = Schema.decodeUnknownSync(
  Schema.Struct({
    config: Schema.Struct({
      mcp_servers: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
    }),
  }),
);

const writeJson = async (path: string, value: unknown) => {
  const temp = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await NodeFSP.rename(temp, path);
};

export async function stopOwnedChild(child: NodeChildProcess.ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = NodeEvents.EventEmitter.once(child, "exit");
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    await exit;
  } finally {
    clearTimeout(force);
  }
}

export async function controlSharedBackend(
  config: SharedCodexConfig,
  command: "status" | "check-idle",
): Promise<SharedCodexState> {
  const state = await readSharedState(config);
  const socket = NodeNet.createConnection(sharedControlPath(config));
  socket.setTimeout(15_000, () => socket.destroy(new Error("Shared Codex control timed out.")));
  try {
    const reply = new Promise<string>((resolveReply, reject) => {
      let text = "";
      socket.on("data", (data) => {
        text += data;
        if (text.includes("\n")) resolveReply(text.split("\n")[0]!);
      });
      socket.on("error", reject);
      socket.on("end", () => {
        if (!text.includes("\n")) reject(new Error("Shared Codex control closed without a reply."));
      });
    });
    socket.on("connect", () =>
      socket.write(JSON.stringify({ token: state.controlToken, command }) + "\n"),
    );
    const result = decodeControlReply(await reply);
    if (result.error) throw new Error(result.error);
    if (result.id !== state.id)
      throw new Error("Shared Codex ownership changed; reconnect and retry.");
    return state;
  } finally {
    socket.destroy();
  }
}

export async function acquireOwner(config: SharedCodexConfig, waitSeconds = 0) {
  if (HostProcessPlatform.defaultValue() !== "darwin")
    throw new Error("Shared Codex startup currently requires macOS.");
  await NodeFSP.mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  const file = await NodeFSP.open(
    NodePath.resolve(config.stateDirectory, "owner.lock"),
    "a+",
    0o600,
  );
  try {
    // BSD flock follows the open file description. lockf acquires it through
    // an inherited descriptor; this process retains it until backend exit.
    // Keep the file: unlinking a lock file permits two different owners.
    const lock = NodeChildProcess.spawn("/usr/bin/lockf", ["-s", "-t", String(waitSeconds), "3"], {
      stdio: ["ignore", "ignore", "pipe", file.fd],
    });
    const [code] = await NodeEvents.EventEmitter.once(lock, "exit");
    if (code !== 0)
      throw new Error(
        "Another Codex launcher owns this backend. Close the duplicate app or reconnect.",
      );
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function assertIdle(url: string) {
  await withSharedRpc(url, async (request) => {
    let cursor: string | null = null;
    do {
      const loaded = decodeLoadedThreads(await request("thread/loaded/list", { cursor }));
      for (const threadId of loaded.data) {
        const result = decodeThreadStatus(
          await request("thread/read", { threadId, includeTurns: false }),
        );
        if (result.thread.status.type === "active")
          throw new Error(
            "Codex has an active turn. Finish or stop it before restarting the backend.",
          );
      }
      cursor = loaded.nextCursor;
    } while (cursor);
  });
}

async function ownBackend(
  config: SharedCodexConfig,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
) {
  if (
    args.includes("--listen") ||
    args.includes("--stdio") ||
    args.some((arg) => arg.startsWith("--listen="))
  )
    throw new Error("The shared launcher owns the transport; remove explicit listen arguments.");
  const id = NodeCrypto.randomUUID();
  // A normal app update can reopen the desktop while its old backend is still
  // closing. Wait for that owner; never start a second writer beside it.
  const lease = await acquireOwner(config, 15);
  let child: NodeChildProcess.ChildProcess | undefined;
  let control: ReturnType<typeof NodeNet.createServer> | undefined;
  let socket: WebSocket | undefined;
  const abort = new AbortController();
  const stop = () => {
    abort.abort();
    socket?.close();
  };
  const pipe = environment.CODEX_APP_TOOLS_PIPE_PATH;
  if (!pipe) {
    await lease.close();
    throw new Error(
      "Codex did not provide its app-tools connection. Start the configured Codex app.",
    );
  }
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.stdout.on("error", stop);
  process.stderr.on("error", stop);
  try {
    child = NodeChildProcess.spawn(config.binaryPath, [...args, "--listen", "ws://127.0.0.1:0"], {
      env: {
        ...environment,
        CODEX_HOME: config.codexHome,
        [SHARED_CLIENT_ENV]: "0",
        [SHARED_AUTOSTART_ENV]: "0",
      },
      stdio: ["ignore", "pipe", "pipe", lease.fd],
    });
    const native = child;
    const url = await new Promise<string>((resolveUrl, reject) => {
      let log = "";
      const timeout = setTimeout(() => reject(new Error("Codex backend did not start.")), 20_000);
      native.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      native.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error("Codex backend exited during startup."));
        stop();
      });
      native.stderr!.on("data", (data) => {
        process.stderr.write(data);
        log = (log + String(data)).slice(-32_000);
        const match = log.match(/listening on: (ws:\/\/127\.0\.0\.1:\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolveUrl(match[1]!);
        }
      });
      native.stdout!.on("data", (data) => process.stderr.write(data));
    });
    socket = await openWebSocket(url, abort.signal);
    const state: SharedCodexState = {
      version: 1,
      id,
      url,
      codexHome: config.codexHome,
      appToolsPipe: pipe,
      backendPid: native.pid!,
      appPid: process.ppid,
      controlToken: NodeCrypto.randomUUID(),
    };
    await NodeFSP.rm(sharedControlPath(config), { force: true });
    control = NodeNet.createServer((client) => {
      let input = "";
      client.setTimeout(10_000, () => client.destroy());
      client.on("error", () => {});
      client.on("data", (data) => {
        input += String(data);
        if (input.length > 4096) {
          client.destroy();
          return;
        }
        if (!input.includes("\n")) return;
        client.removeAllListeners("data");
        void (async () => {
          const request = decodeControlRequest(input.split("\n")[0]!);
          if (request.token !== state.controlToken)
            throw new Error("Invalid shared-backend control credential.");
          if (request.command === "check-idle") await assertIdle(url);
          client.end(JSON.stringify({ id }) + "\n");
        })().catch((error) =>
          client.end(
            JSON.stringify({
              id,
              error: error instanceof Error ? error.message : "Shared backend request failed.",
            }) + "\n",
          ),
        );
      });
    });
    await new Promise<void>((resolveListen, reject) => {
      control!.once("error", reject);
      control!.listen(sharedControlPath(config), resolveListen);
    });
    await NodeFSP.chmod(sharedControlPath(config), 0o600);
    await writeJson(sharedStatePath(config), state);
    await relayStdio(socket, process.stdin, process.stdout, false);
  } finally {
    socket?.close();
    if (child) await stopOwnedChild(child);
    if (control) await new Promise<void>((resolveClose) => control!.close(() => resolveClose()));
    await NodeFSP.rm(sharedStatePath(config), { force: true });
    await NodeFSP.rm(sharedControlPath(config), { force: true });
    await lease.close();
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    process.stdout.off("error", stop);
    process.stderr.off("error", stop);
  }
}

async function waitForBackend(config: SharedCodexConfig): Promise<SharedCodexState> {
  await NodeFSP.mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new Error(
          "Codex is running without a compatible shared backend, or could not start. Restart Codex using the installed shared launch settings.",
        ),
      ),
    20_000,
  );
  try {
    const events = NodeFSP.watch(config.stateDirectory, { signal: controller.signal });
    try {
      return await controlSharedBackend(config, "status");
    } catch {
      /* Wait for the launched app to publish readiness. */
    }
    for await (const event of events) {
      if (event.filename === "backend.json") {
        try {
          return await controlSharedBackend(config, "status");
        } catch {
          /* Publication can race socket readiness during shutdown. */
        }
      }
    }
    throw new Error("Codex did not publish its shared backend.");
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

async function attachClient(config: SharedCodexConfig, environment: NodeJS.ProcessEnv) {
  if (environment.CODEX_HOME && NodePath.resolve(environment.CODEX_HOME) !== config.codexHome)
    throw new Error(
      "T3's Codex home differs from the installed shared launcher's home. Configure the same home in T3.",
    );
  let state: SharedCodexState;
  try {
    state = await controlSharedBackend(config, "status");
  } catch (error) {
    if (environment[SHARED_AUTOSTART_ENV] !== "1")
      throw new Error("Codex's shared backend is unavailable. Starting a task will open Codex.", {
        cause: error,
      });
    if (HostProcessPlatform.defaultValue() !== "darwin")
      throw new Error("Automatic Codex app launch currently requires macOS.", { cause: error });
    const app = NodeChildProcess.spawn(
      "/usr/bin/open",
      [
        "-a",
        config.appPath,
        "--env",
        `CODEX_CLI_PATH=${config.launcherPath}`,
        "--env",
        `CODEX_HOME=${config.codexHome}`,
        "--env",
        `${SHARED_CLIENT_ENV}=0`,
        "--env",
        `${SHARED_AUTOSTART_ENV}=0`,
      ],
      { stdio: "ignore" },
    );
    const exited = await NodeEvents.EventEmitter.once(app, "exit");
    if (exited[0] !== 0) throw new Error("macOS could not open Codex.", { cause: error });
    state = await waitForBackend(config);
  }
  // Save only the MCP entry this integration replaces, preserving unrelated
  // config edits when the launcher is later removed.
  try {
    await NodeFSP.access(sharedMcpBackupPath(config));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const previous = await withSharedRpc(state.url, async (request) => {
      const response = decodeMcpConfig(await request("config/read", { includeLayers: false }));
      return response.config.mcp_servers?.["t3-shared"] ?? null;
    });
    try {
      await NodeFSP.writeFile(sharedMcpBackupPath(config), JSON.stringify({ value: previous }), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
  const socket = await openWebSocket(state.url, AbortSignal.timeout(10_000));
  const stop = () => socket.close();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    await relayStdio(socket, process.stdin, process.stdout, true);
  } finally {
    socket.close();
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}

/** NSRunningApplication targets the recorded owning instance, including an
 * isolated test instance; a bundle-name Apple Event would target the wrong app. */
export async function quitOwningDesktop(
  config: SharedCodexConfig,
  state: SharedCodexState,
): Promise<void> {
  const script = `function run(argv) {
    ObjC.import('AppKit');
    const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0]));
    if (!app || app.isNil() || app.bundleURL.path.js !== argv[1]) throw Error('The owning Codex app changed. Refresh shared-status before restarting.');
    if (!app.terminate) throw Error('Codex refused to quit. Finish outstanding work and quit it manually.');
    const deadline = Date.now() + 10000;
    while (!app.terminated) {
      if (Date.now() > deadline) throw Error('Codex is still quitting. Wait for it to close before reopening.');
      $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
    }
  }`;
  const quitter = NodeChildProcess.spawn(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", script, String(state.appPid), config.appPath],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let errors = "";
  quitter.stderr.on("data", (data) => {
    errors += String(data);
  });
  const [code] = await NodeEvents.EventEmitter.once(quitter, "exit");
  if (code !== 0) throw new Error(errors.trim() || "Could not quit the owning Codex app.");
}

async function restartDesktop(
  config: SharedCodexConfig,
  state: SharedCodexState,
): Promise<SharedCodexState> {
  await quitOwningDesktop(config, state);
  // Desktop waits for its stdio child during shutdown. The native backend also
  // inherits this lease, so a remaining writer prevents opening a replacement.
  const lease = await acquireOwner(config, 15);
  await lease.close();
  const app = NodeChildProcess.spawn(
    "/usr/bin/open",
    [
      "-a",
      config.appPath,
      "--env",
      `CODEX_CLI_PATH=${config.launcherPath}`,
      "--env",
      `CODEX_HOME=${config.codexHome}`,
      "--env",
      `${SHARED_CLIENT_ENV}=0`,
      "--env",
      `${SHARED_AUTOSTART_ENV}=0`,
    ],
    { stdio: "ignore" },
  );
  const [code] = await NodeEvents.EventEmitter.once(app, "exit");
  if (code !== 0) throw new Error("macOS could not reopen Codex.");
  return await waitForBackend(config);
}

async function isDesktopParent(config: SharedCodexConfig): Promise<boolean> {
  if (HostProcessPlatform.defaultValue() !== "darwin") return false;
  const check = NodeChildProcess.spawn("/bin/ps", ["-p", String(process.ppid), "-o", "comm="], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let command = "";
  check.stdout.on("data", (data) => {
    command += String(data);
  });
  const [code] = await NodeEvents.EventEmitter.once(check, "exit");
  return code === 0 && command.trim().startsWith(`${config.appPath}/Contents/MacOS/`);
}

export async function runSharedLauncher(
  configPath: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const config = await readSharedConfig(configPath);
  const server = args.indexOf("app-server");
  const ordinaryServer =
    server >= 0 &&
    (args[server + 1] === undefined || args[server + 1]!.startsWith("-")) &&
    !args.includes("--help");
  if (args[0] === "shared-status" || args[0] === "shared-restart") {
    const state = await controlSharedBackend(
      config,
      args[0] === "shared-status" ? "status" : "check-idle",
    );
    const current = args[0] === "shared-restart" ? await restartDesktop(config, state) : state;
    process.stdout.write(
      JSON.stringify({
        id: current.id,
        backendPid: current.backendPid,
        codexHome: current.codexHome,
      }) + "\n",
    );
    return 0;
  }
  if (ordinaryServer && environment.CODEX_APP_TOOLS_PIPE_PATH && (await isDesktopParent(config))) {
    const desktopHome = NodePath.resolve(
      environment.CODEX_HOME || NodePath.resolve(environment.HOME || NodeOS.homedir(), ".codex"),
    );
    if (desktopHome !== config.codexHome)
      throw new Error(
        "The Codex app uses a different Codex home than the shared launcher. Configure both apps to use the same home.",
      );
    await ownBackend(config, args, environment);
    return 0;
  }
  if (ordinaryServer && environment[SHARED_CLIENT_ENV] === "1") {
    await attachClient(config, environment);
    return 0;
  }
  const child = NodeChildProcess.spawn(config.binaryPath, [...args], {
    env: environment,
    stdio: "inherit",
  });
  const terminate = () => child.kill("SIGTERM");
  process.on("SIGTERM", terminate);
  process.on("SIGINT", terminate);
  try {
    const result = await NodeEvents.EventEmitter.once(child, "exit");
    return typeof result[0] === "number" ? result[0] : 1;
  } finally {
    process.off("SIGTERM", terminate);
    process.off("SIGINT", terminate);
  }
}
