// @effect-diagnostics nodeBuiltinImport:off - runs the real session-start hook script.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ServerConfig from "../config.ts";
import {
  layer as registerLayer,
  REGISTER_FOLDER_NAME,
  registerFileNames,
  UsageSessionRegister,
} from "./UsageSessionRegister.ts";

const HOOK = NodePath.resolve(import.meta.dirname, "../../scripts/session-register-hook.sh");

/** Runs the hook as a harness does: the payload on stdin and only the given variables set. */
const runHook = (input: {
  readonly args: ReadonlyArray<string>;
  readonly payload?: string;
  readonly env?: Record<string, string>;
}) =>
  NodeChildProcess.spawnSync(HOOK, input.args, {
    input: input.payload ?? "",
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...input.env },
  });

const withBaseDir = <A, E>(
  body: (baseDir: string) => Effect.Effect<A, E, UsageSessionRegister | FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-session-register-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
    );
    return yield* body(baseDir).pipe(
      Effect.provide(
        registerLayer.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  }).pipe(Effect.scoped);

describe("session register", () => {
  it.effect("the hook's lines are what Usage reads, from each tool's payload", () =>
    withBaseDir((baseDir) =>
      Effect.gen(function* () {
        const folder = NodePath.join(baseDir, "userdata", REGISTER_FOLDER_NAME);
        const claude = runHook({
          args: ["claude", folder],
          payload: JSON.stringify({
            session_id: "claude-session",
            hook_event_name: "SessionStart",
            source: "startup",
            cwd: '/work/a "quoted" \\ folder',
          }),
          env: {
            T3CODE_THREAD_ID: "mcp:thread",
            FM_TASK_ID: "task-a",
            FM_HOME: "/fm home",
          },
        });
        // Grok also runs Claude's hooks, and names its session in camel case.
        const grok = runHook({
          args: ["claude", folder],
          payload: '{"hookEventName":"session_start",\n "sessionId": "grok-session", "cwd":"/g"}',
          env: { GROK_HOOK_EVENT: "session_start" },
        });
        const codex = runHook({
          args: ["codex", folder],
          payload: JSON.stringify({ session_id: "codex-session", cwd: "/c" }),
        });
        for (const run of [claude, grok, codex]) {
          assert.strictEqual(run.status, 0);
          assert.strictEqual(run.stdout, "");
          assert.strictEqual(run.stderr, "");
        }

        // One file per UTC month; the runs may straddle a month's end.
        const files = NodeFS.readdirSync(folder).toSorted();
        for (const file of files) assert.match(file, /^\d{4}-\d{2}\.jsonl$/);
        const monthStart = Date.parse(`${files[0]!.slice(0, 7)}-01T00:00:00Z`);
        const read = yield* (yield* UsageSessionRegister).read(
          monthStart,
          monthStart + 62 * 24 * 60 * 60 * 1000,
        );
        assert.deepStrictEqual(
          read.map(({ startedAtMs, ...entry }) => {
            assert.isTrue(startedAtMs >= monthStart);
            return entry;
          }),
          [
            {
              sessionId: "claude-session",
              provider: "claude",
              cwd: '/work/a "quoted" \\ folder',
              threadId: "mcp:thread",
              fmTaskId: "task-a",
              fmHome: "/fm home",
            },
            { sessionId: "grok-session", provider: "grok", cwd: "/g" },
            { sessionId: "codex-session", provider: "codex", cwd: "/c" },
          ],
        );
      }),
    ),
  );

  it("the hook never fails or speaks, even when it cannot register", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-session-register-"));
    try {
      const blocked = NodePath.join(root, "a-file");
      NodeFS.writeFileSync(blocked, "");
      const runs = [
        runHook({ args: [] }),
        runHook({ args: ["claude", NodePath.join(root, "register")], payload: "not json" }),
        runHook({
          args: ["claude", NodePath.join(blocked, "register")],
          payload: '{"session_id":"s"}',
        }),
      ];
      for (const run of runs) {
        assert.strictEqual(run.status, 0);
        assert.strictEqual(run.stdout, "");
        assert.strictEqual(run.stderr, "");
      }
      assert.deepStrictEqual(NodeFS.readdirSync(root), ["a-file"]);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it.effect("reads only the months a window covers, skipping lines it cannot read", () =>
    withBaseDir((baseDir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const folder = NodePath.join(baseDir, "userdata", REGISTER_FOLDER_NAME);
        yield* fs.makeDirectory(folder, { recursive: true });
        const line = (sessionId: string, startedAt: string) =>
          JSON.stringify({ v: 1, sessionId, startedAt, provider: "claude" });
        yield* fs.writeFileString(
          NodePath.join(folder, "2026-10.jsonl"),
          `${line("too-early", "2026-10-30T23:59:59Z")}\n${line("october", "2026-10-31T12:00:00Z")}\n`,
        );
        yield* fs.writeFileString(
          NodePath.join(folder, "2026-11.jsonl"),
          [
            line("november", "2026-11-01T00:00:00Z"),
            '{"v":1,"sessionId":"cut-short',
            JSON.stringify({ v: 2, sessionId: "future", startedAt: "2026-11-01T00:00:00Z" }),
            line("bad-time", "yesterday"),
            line("too-late", "2026-11-02T00:00:00Z"),
          ].join("\n"),
        );
        yield* fs.writeFileString(
          NodePath.join(folder, "2026-12.jsonl"),
          line("unread", "2026-11-01T00:00:00Z"),
        );
        const read = yield* (yield* UsageSessionRegister).read(
          Date.parse("2026-10-31T00:00:00Z"),
          Date.parse("2026-11-02T00:00:00Z"),
        );
        assert.deepStrictEqual(
          read.map((entry) => entry.sessionId),
          ["october", "november"],
        );
      }),
    ),
  );
});

describe("registerFileNames", () => {
  it("names each UTC month a window touches, across a year end", () => {
    assert.deepStrictEqual(
      registerFileNames(Date.parse("2026-11-30T23:00:00Z"), Date.parse("2027-01-01T00:00:00Z")),
      ["2026-11.jsonl", "2026-12.jsonl", "2027-01.jsonl"],
    );
  });
});
