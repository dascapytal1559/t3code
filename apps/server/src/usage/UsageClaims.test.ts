import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { MessageId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { ensureForkSchema } from "../persistence/forkSchema.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as UsageClaims from "./UsageClaims.ts";

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "a folder claim is stored at its real path and removed by the linked path once deleted",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const claims = yield* UsageClaims.UsageClaims;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3-usage-claims-" });
      yield* fs.makeDirectory(path.join(base, "real", "run1"), { recursive: true });
      yield* fs.symlink(path.join(base, "real"), path.join(base, "link"));
      const linked = path.join(base, "link", "run1");
      const stored = path.join(yield* fs.realPath(base), "real", "run1");
      const causedBy = { threadId: ThreadId.make("lead"), messageId: MessageId.make("prompt") };

      yield* claims.claim({
        target: { kind: "directory", directory: linked },
        value: { causedBy },
      });
      assert.deepStrictEqual(yield* claims.read, [
        { kind: "directory", target: stored, causeMessageId: "prompt", device: null },
      ]);

      yield* fs.remove(path.join(base, "real", "run1"), { recursive: true });
      const removed = yield* claims.claim({
        target: { kind: "directory", directory: linked },
        value: null,
      });
      assert.deepStrictEqual(removed.target, { kind: "directory", directory: stored });
      assert.deepStrictEqual(yield* claims.read, []);
    }).pipe(
      Effect.provide(
        UsageClaims.layer.pipe(
          Layer.provideMerge(Layer.merge(Sqlite.layerMemory, NodeServices.layer)),
        ),
      ),
    ),
);

it.effect("a session claimed from several start times keeps one claim per start", () =>
  Effect.gen(function* () {
    const claims = yield* UsageClaims.UsageClaims;
    const session = (from?: string) => ({
      kind: "session" as const,
      sessionId: "engine",
      ...(from === undefined ? {} : { from: DateTime.makeUnsafe(from) }),
    });
    yield* claims.claim({ target: session(), value: { device: "computer" } });
    yield* claims.claim({ target: session("2026-11-16T01:00:00Z"), value: { device: "computer" } });
    yield* claims.claim({ target: session("2026-11-16T02:00:00Z"), value: { device: "computer" } });
    // The same start, written another way, replaces its claim.
    yield* claims.claim({
      target: session("2026-11-16T12:00:00+11:00"),
      value: { device: "phone" },
    });
    yield* claims.claim({ target: session("2026-11-16T02:00:00Z"), value: null });
    assert.deepStrictEqual(yield* claims.read, [
      { kind: "session", target: "engine", causeMessageId: null, device: "computer" },
      {
        kind: "session",
        target: "engine",
        fromMs: Date.parse("2026-11-16T01:00:00Z"),
        causeMessageId: null,
        device: "phone",
      },
    ]);
  }).pipe(
    Effect.provide(
      UsageClaims.layer.pipe(
        Layer.provideMerge(Layer.merge(Sqlite.layerMemory, NodeServices.layer)),
      ),
    ),
  ),
);

it.effect("older claims tables are rebuilt keeping their claims, then take start times", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const claims = yield* UsageClaims.UsageClaims;
    const before = [
      sql`
        CREATE TABLE usage_claims (
          target_kind TEXT NOT NULL CHECK (target_kind IN ('session', 'directory')),
          target TEXT NOT NULL,
          cause_thread_id TEXT NOT NULL,
          cause_run_id TEXT,
          cause_message_id TEXT NOT NULL,
          claimed_at TEXT NOT NULL,
          PRIMARY KEY (target_kind, target)
        )
      `.pipe(
        Effect.andThen(
          sql`INSERT INTO usage_claims VALUES ('session', 'pipeline', 'lead', NULL, 'prompt', '2026-11-14T00:00:00Z')`,
        ),
      ),
      sql`
        CREATE TABLE usage_claims (
          target_kind TEXT NOT NULL CHECK (target_kind IN ('session', 'directory', 'run')),
          target TEXT NOT NULL,
          cause_thread_id TEXT,
          cause_run_id TEXT,
          cause_message_id TEXT,
          device TEXT CHECK (device IN ('phone', 'computer')),
          claimed_at TEXT NOT NULL,
          PRIMARY KEY (target_kind, target),
          CHECK ((cause_message_id IS NULL) <> (device IS NULL))
        )
      `.pipe(
        Effect.andThen(
          sql`INSERT INTO usage_claims VALUES ('session', 'pipeline', 'lead', NULL, 'prompt', NULL, '2026-11-14T00:00:00Z'), ('run', 'run:journal', NULL, NULL, NULL, 'phone', '2026-11-14T00:00:00Z')`,
        ),
      ),
    ];
    const kept = [
      [{ kind: "session", target: "pipeline", causeMessageId: "prompt", device: null }],
      [
        { kind: "session", target: "pipeline", causeMessageId: "prompt", device: null },
        { kind: "run", target: "run:journal", causeMessageId: null, device: "phone" },
      ],
    ] as const;
    for (const [index, create] of before.entries()) {
      yield* sql`DROP TABLE usage_claims`;
      yield* create;
      yield* ensureForkSchema();
      yield* claims.claim({
        target: { kind: "run", runId: "run:wake" },
        value: { device: "computer" },
      });
      yield* claims.claim({
        target: {
          kind: "session",
          sessionId: "pipeline",
          from: DateTime.makeUnsafe("2026-11-16T00:00:00Z"),
        },
        value: { device: "computer" },
      });
      assert.deepStrictEqual(yield* claims.read, [
        ...kept[index]!,
        { kind: "run", target: "run:wake", causeMessageId: null, device: "computer" },
        {
          kind: "session",
          target: "pipeline",
          fromMs: Date.parse("2026-11-16T00:00:00Z"),
          causeMessageId: null,
          device: "computer",
        },
      ]);
    }
  }).pipe(
    Effect.provide(
      UsageClaims.layer.pipe(
        Layer.provideMerge(Layer.merge(Sqlite.layerMemory, NodeServices.layer)),
      ),
    ),
  ),
);
