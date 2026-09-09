// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";
import { runSharedLauncher } from "./codexShared/launcher.ts";
import { installSharedLauncher, uninstallSharedLauncher } from "./codexShared/install.ts";

const args = process.argv.slice(2);
try {
  if (args[0] === "install") {
    const values = new Map<string, string>();
    for (let i = 1; i < args.length; i += 2) {
      const key = args[i];
      const value = args[i + 1];
      if (
        !key ||
        !value ||
        !["--app", "--codex-home", "--directory", "--launch-agents"].includes(key) ||
        values.has(key)
      )
        throw new Error("Invalid or duplicate installation argument.");
      values.set(key, value);
    }
    const required = (key: string) => {
      const value = values.get(key);
      if (!value) throw new Error(`Required installation argument: ${key}`);
      return value;
    };
    const config = await installSharedLauncher({
      appPath: required("--app"),
      codexHome: required("--codex-home"),
      directory: required("--directory"),
      launchAgentsDirectory: required("--launch-agents"),
      bundlePath: NodeURL.fileURLToPath(import.meta.url),
    });
    process.stdout.write(
      `Shared launcher installed: ${config.launcherPath}\nQuit and reopen Codex to activate it. Set T3's Shared Codex app launcher to this path.\n`,
    );
  } else if (args[0] === "--shared-config" && args[1]) {
    if (args[2] === "shared-uninstall") {
      await uninstallSharedLauncher(args[1]);
      process.stdout.write(
        "Shared launch settings removed; previous login environment restored. Clear T3's shared launcher setting.\n",
      );
    } else process.exitCode = await runSharedLauncher(args[1], args.slice(2));
  } else
    throw new Error(
      "Use install --app PATH --codex-home PATH --directory PATH --launch-agents PATH, or the installed launcher.",
    );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
