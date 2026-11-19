import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as UsageClose from "./UsageClose.ts";
import {
  applyRelabel,
  planRelabel,
  type RelabelLabel,
  type RelabelManifest,
  RelabelRefused,
  undoRelabel,
} from "./UsageRelabel.ts";

const T = Date.parse("2026-11-17T00:00:00Z");
const label = (overrides: Partial<RelabelLabel>): RelabelLabel => ({
  device: "phone",
  origin: "phone",
  basis: "stamp",
  reason: "inherited",
  via: "crew",
  claim: null,
  folder: 0,
  registered: 0,
  cause: 0,
  root_thread_id: "firstmate",
  root_message_id: "goodnight",
  ...overrides,
});
const phone = label({});
const upkeep = label({
  device: "computer",
  origin: "computer",
  basis: "claim",
  reason: "upkeep",
  root_thread_id: null,
  root_message_id: null,
});

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO usage_close (id, closed_from_ms, closed_through_ms, closed_at)
    VALUES (1, ${T - 86_400_000}, ${T + 86_400_000}, '2026-11-18T01:00:00.000Z')
  `;
  const session = (sessionId: string, fromMs: number, value: RelabelLabel, runId: string | null) =>
    sql`INSERT INTO usage_closed_session_labels ${sql.insert({
      session_id: sessionId,
      from_ms: fromMs,
      ...value,
      run_id: runId,
      typed: 0,
    })}`;
  // The nightly worker, then FirstMate's own session: a wake about it, and a typed turn.
  yield* session("nightly", T, phone, "run-nightly-1");
  yield* session("nightly", T + 60_000, phone, null);
  yield* session("firstmate", T + 120_000, phone, "run-wake");
  yield* session("firstmate", T + 180_000, label({ reason: "typed", via: null }), "run-typed");
  yield* sql`INSERT INTO usage_closed_prompt_labels ${sql.insert({
    message_id: "wake-prompt",
    thread_id: "firstmate",
    created_at_ms: T + 120_000,
    ...phone,
  })}`;
});

const manifest: RelabelManifest = {
  reason: "The bedtime routine counts to the computer.",
  rows: [
    { table: "session", sessionId: "nightly", fromMs: T, old: phone, new: upkeep, why: "routine" },
    {
      table: "session",
      sessionId: "nightly",
      fromMs: T + 60_000,
      old: phone,
      new: upkeep,
      why: "routine",
    },
    {
      table: "session",
      sessionId: "firstmate",
      fromMs: T + 120_000,
      old: phone,
      new: { ...upkeep, claim: "run" },
      why: "wake about the routine",
    },
    {
      table: "prompt",
      messageId: "wake-prompt",
      old: phone,
      new: { ...upkeep, claim: "run" },
      why: "wake about the routine",
    },
  ],
};

/** Every row of the closed tables, each value as its SQL literal, so types are compared too. */
const dump = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const out: Record<string, string[]> = {};
  for (const table of [
    "usage_close",
    "usage_closed_session_labels",
    "usage_closed_prompt_labels",
    "usage_relabels",
  ]) {
    const columns = (yield* sql<{ readonly name: string }>`PRAGMA table_info(${sql(table)})`).map(
      ({ name }) => `quote(${name})`,
    );
    const rows = yield* sql<{ readonly row: string }>`
      SELECT ${sql.literal(columns.join(" || ',' || "))} AS row FROM ${sql(table)} ORDER BY rowid
    `;
    out[table] = rows.map(({ row }) => row);
  }
  return out;
});

const layer = Layer.merge(Sqlite.layerMemory, NodeServices.layer);

it.effect("a relabel dry run reports each row and writes nothing", () =>
  Effect.gen(function* () {
    yield* seed;
    const before = yield* dump;
    const plan = yield* planRelabel(manifest);
    assert.deepStrictEqual(plan.states, {
      toChange: 4,
      alreadyNew: 0,
      differs: 0,
      missing: 0,
      notClosed: 0,
    });
    assert.deepStrictEqual(plan.moves, { "phone>computer": 4 });
    assert.deepStrictEqual(yield* dump, before);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a relabel changes exactly its rows, reads back on the closed day, and undoes byte for byte",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const backupDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-usage-relabel-" });
      yield* seed;
      const before = yield* dump;

      const applied = yield* applyRelabel({ manifest, backupDir });
      const after = yield* dump;
      const changed = (table: string) =>
        after[table]!.filter((row) => !before[table]!.includes(row)).length;
      assert.strictEqual(changed("usage_closed_session_labels"), 3);
      assert.strictEqual(changed("usage_closed_prompt_labels"), 1);
      assert.deepStrictEqual(after["usage_close"], before["usage_close"]);
      // The typed turn is not in the manifest and keeps its label.
      assert.include(after["usage_closed_session_labels"]![3]!, "'typed'");
      const backup = JSON.parse(yield* fs.readFileString(applied.backupPath));
      assert.strictEqual(backup.tables.usage_closed_session_labels.length, 4);
      assert.strictEqual(backup.tables.usage_closed_session_labels[0].device, "phone");

      // The Usage page reads closed days from these rows.
      const store = UsageClose.makeClosedStore(sql);
      const stored = new UsageClose.ClosedLabels(
        yield* store.sessionLabels(["nightly", "firstmate"], T + 86_400_000),
      );
      const at = (sessionId: string, offsetMs: number) => {
        const key = stored.labelAt({ sessionId, timestampMs: T + offsetMs });
        return `${key?.origin} ${key?.basis} ${key?.reason}`;
      };
      assert.deepStrictEqual(
        [at("nightly", 30_000), at("nightly", 90_000), at("firstmate", 150_000)],
        ["computer claim upkeep", "computer claim upkeep", "computer claim upkeep"],
      );
      assert.strictEqual(at("firstmate", 200_000), "phone stamp typed");
      const [prompt] = yield* store.promptLabels(T, T + 86_400_000);
      assert.strictEqual(prompt?.key.origin, "computer");

      const undone = yield* undoRelabel(applied.id);
      assert.strictEqual(undone.rows, 4);
      const restored = yield* dump;
      for (const table of [
        "usage_close",
        "usage_closed_session_labels",
        "usage_closed_prompt_labels",
      ]) {
        assert.deepStrictEqual(restored[table], before[table]);
      }
      // The change set stays on record, marked undone, and cannot be undone twice.
      assert.strictEqual(restored["usage_relabels"]!.length, 1);
      const twice = yield* Effect.flip(undoRelabel(applied.id));
      assert.instanceOf(twice, RelabelRefused);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("a repeated or stale relabel is refused and changes nothing", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const backupDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-usage-relabel-" });
    yield* seed;
    const applied = yield* applyRelabel({ manifest, backupDir });
    const after = yield* dump;

    const again = yield* Effect.flip(applyRelabel({ manifest, backupDir }));
    assert.include(again.message, applied.id);
    const plan = yield* planRelabel(manifest);
    assert.strictEqual(plan.states.alreadyNew, 4);
    assert.strictEqual(plan.appliedAs, applied.id);

    // A manifest whose old label no longer matches, or that reaches past the close, is refused whole.
    yield* undoRelabel(applied.id);
    yield* sql`UPDATE usage_close SET closed_through_ms = ${T + 90_000}`;
    const late = yield* Effect.flip(applyRelabel({ manifest, backupDir }));
    assert.include(late.message, "2 of 4 rows");
    yield* sql`UPDATE usage_close SET closed_through_ms = ${T + 86_400_000}`;
    yield* sql`UPDATE usage_closed_session_labels SET reason = 'typed' WHERE from_ms = ${T}`;
    const stale = yield* Effect.flip(applyRelabel({ manifest, backupDir }));
    assert.include(stale.message, "1 of 4 rows");
    const restored = yield* dump;
    assert.notDeepEqual(
      restored["usage_closed_session_labels"],
      after["usage_closed_session_labels"],
    );
    assert.strictEqual(restored["usage_relabels"]!.length, 1);
    assert.strictEqual(
      restored["usage_closed_session_labels"]!.filter((row) => row.includes("'upkeep'")).length,
      0,
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
