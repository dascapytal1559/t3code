import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { MessageId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
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

it.effect("the first claims table is rebuilt keeping its claims, then takes devices and runs", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const claims = yield* UsageClaims.UsageClaims;
    yield* sql`DROP TABLE usage_claims`;
    yield* sql`
      CREATE TABLE usage_claims (
        target_kind TEXT NOT NULL CHECK (target_kind IN ('session', 'directory')),
        target TEXT NOT NULL,
        cause_thread_id TEXT NOT NULL,
        cause_run_id TEXT,
        cause_message_id TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        PRIMARY KEY (target_kind, target)
      )
    `;
    yield* sql`
      INSERT INTO usage_claims VALUES ('session', 'pipeline', 'lead', NULL, 'prompt', '2026-11-14T00:00:00Z')
    `;

    yield* ensureForkSchema();
    yield* claims.claim({
      target: { kind: "run", runId: "run:wake" },
      value: { device: "computer" },
    });
    assert.deepStrictEqual(yield* claims.read, [
      { kind: "session", target: "pipeline", causeMessageId: "prompt", device: null },
      { kind: "run", target: "run:wake", causeMessageId: null, device: "computer" },
    ]);
  }).pipe(
    Effect.provide(
      UsageClaims.layer.pipe(
        Layer.provideMerge(Layer.merge(Sqlite.layerMemory, NodeServices.layer)),
      ),
    ),
  ),
);
