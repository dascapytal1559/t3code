// @effect-diagnostics nodeBuiltinImport:off
// Fork: an explicit npm tarball must run instead of a stock release archive.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import { buildRemoteLaunchScript, buildRemoteT3RunnerScript } from "./tunnel.ts";

describe("ssh tunnel scripts (fork)", () => {
  it("installs the explicit tarball with audit disabled and executes its CLI", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-runner-"));
    try {
      const cli = NodePath.join(directory, "fork-cli");
      const installLog = NodePath.join(directory, "install.log");
      const packageSpec = "/tmp/fork's package; literal.tgz";
      NodeFS.writeFileSync(cli, '#!/bin/sh\nprintf "fork:%s\\n" "$@"\n', { mode: 0o755 });
      NodeFS.writeFileSync(
        NodePath.join(directory, "npx"),
        [
          "#!/bin/sh",
          'printf "%s\\n" "$npm_config_audit" "$npm_config_fund" "$@" > "$INSTALL_LOG"',
          'printf "%s\\n" "$FORK_CLI"',
        ].join("\n"),
        { mode: 0o755 },
      );
      NodeFS.writeFileSync(NodePath.join(directory, "t3"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
      const script = NodePath.join(directory, "runner.sh");
      NodeFS.writeFileSync(
        script,
        buildRemoteT3RunnerScript({
          packageSpec,
          archiveVersion: "0.0.41",
        }),
      );
      const result = NodeChildProcess.execFileSync("sh", [script, "--version"], {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          INSTALL_LOG: installLog,
          FORK_CLI: cli,
        },
        encoding: "utf8",
      });
      expect(result).toBe("fork:--version\n");
      expect(NodeFS.readFileSync(installLog, "utf8").split("\n")).toEqual([
        "false",
        "false",
        "--yes",
        "--package",
        packageSpec,
        "--",
        "sh",
        "-c",
        "command -v t3",
        "",
      ]);
      expect(buildRemoteLaunchScript({ packageSpec })).toContain("T3_ARCHIVE_MODE=0");
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses upstream's release archive when the override is blank", () => {
    const script = buildRemoteT3RunnerScript({ packageSpec: " ", archiveVersion: "0.0.41" });
    expect(script).toContain('exec "$T3_RUNTIME_DIR/t3" "$@"');
    expect(script).not.toContain("npx");
  });
});
