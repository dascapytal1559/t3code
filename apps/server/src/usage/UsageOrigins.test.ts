import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../persistence/Sqlite.ts";
import {
  classifyMessageOrigin,
  layer as usageOriginsLayer,
  UsageOriginIndex,
  UsageOrigins,
  type OriginMessage,
} from "./UsageOrigins.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const message = (overrides: Partial<OriginMessage>): OriginMessage => ({
  createdBy: "user",
  creationSource: "web",
  surface: null,
  deviceType: null,
  crew: false,
  ...overrides,
});

describe("classifyMessageOrigin", () => {
  it("buckets stamps by device and leaves older messages unknown unless their creation says more", () => {
    const cases: ReadonlyArray<readonly [Partial<OriginMessage>, string]> = [
      [{ surface: "web", deviceType: "mobile" }, "phone/stamp"],
      [{ surface: "web", deviceType: "tablet" }, "phone/stamp"],
      [{ creationSource: "mobile", surface: "mobile", deviceType: "mobile" }, "phone/stamp"],
      [{ surface: "desktop", deviceType: "desktop" }, "computer/stamp"],
      [{ surface: "web", deviceType: "desktop" }, "computer/stamp"],
      [{ surface: "web", deviceType: "unknown" }, "unknown/stamp"],
      [
        { createdBy: "agent", creationSource: "mcp", surface: "mcp", deviceType: "bot" },
        "agent/stamp",
      ],
      [{ creationSource: "mobile" }, "phone/nativeApp"],
      [{ createdBy: "agent", creationSource: "mcp" }, "agent/sender"],
      [{ createdBy: "agent", creationSource: "provider" }, "agent/sender"],
      [{ createdBy: "agent", creationSource: "server" }, "agent/sender"],
      [{ creationSource: "web" }, "unknown/unstamped"],
      [{ creationSource: "server" }, "unknown/server"],
      [{ createdBy: null, creationSource: null }, "unknown/unstamped"],
      [{ crew: true, createdBy: "agent", creationSource: "mcp" }, "crew/sender"],
      [{ crew: true, surface: "mcp", deviceType: "bot" }, "crew/stamp"],
      // A prompt the captain types into a crew thread is still his device's.
      [{ crew: true, surface: "web", deviceType: "mobile" }, "phone/stamp"],
      [{ crew: true, creationSource: "web" }, "unknown/unstamped"],
    ];
    for (const [input, expected] of cases) {
      const { origin, basis } = classifyMessageOrigin(message(input));
      assert.strictEqual(`${origin}/${basis}`, expected, JSON.stringify(input));
    }
  });
});

describe("UsageOriginIndex", () => {
  it("credits a record to its session's turn running at the time", () => {
    const phone = { origin: "phone", basis: "stamp" } as const;
    const agent = { origin: "agent", basis: "stamp" } as const;
    const index = new UsageOriginIndex([
      { sessionId: "s", startedAtMs: 2_000, completedAtMs: null, key: agent },
      { sessionId: "s", startedAtMs: 1_000, completedAtMs: 1_500, key: phone },
    ]);
    assert.strictEqual(index.lookup("s", 999), null);
    assert.deepStrictEqual(index.lookup("s", 1_000), phone);
    // Late records within the grace still belong to the finished turn.
    assert.deepStrictEqual(index.lookup("s", 1_900), phone);
    assert.deepStrictEqual(index.lookup("s", 2_000), agent);
    assert.deepStrictEqual(index.lookup("s", 10 * 60 * 1000), agent);
    assert.strictEqual(index.lookup("other", 1_200), null);

    const finished = new UsageOriginIndex([
      { sessionId: "s", startedAtMs: 0, completedAtMs: 1_000, key: phone },
    ]);
    // A terminal resume of the session long after the T3 turn ended is not T3's.
    assert.strictEqual(finished.lookup("s", 1_000 + 6 * 60 * 1000), null);
  });
});

const seedThread = (input: { id: string; crewOf?: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({
      thread_id: input.id,
      project_id: "project",
      title: input.id,
      default_provider: "claudeAgent",
      runtime_mode: "full-access",
      interaction_mode: "default",
      created_at: "2026-08-07T00:00:00.000Z",
      updated_at: "2026-08-07T00:00:00.000Z",
      payload_json: encodeJson({ id: input.id, crewOf: input.crewOf ?? null }),
    })}`;
  });

const seedRun = (input: {
  id: string;
  ordinal: number;
  threadId: string;
  sessionId: string;
  startedAt: string;
  completedAt?: string;
  message?: Record<string, unknown>;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const providerThreadId = `provider-thread-${input.sessionId}`;
    yield* sql`INSERT OR IGNORE INTO orchestration_v2_projection_provider_threads ${sql.insert({
      provider_thread_id: providerThreadId,
      thread_id: input.threadId,
      provider: "claudeAgent",
      status: "active",
      updated_at: input.startedAt,
      payload_json: encodeJson({
        nativeThreadRef: { driver: "claudeAgent", nativeId: input.sessionId, strength: "strong" },
      }),
    })}`;
    if (input.message !== undefined) {
      yield* sql`INSERT INTO orchestration_v2_projection_messages ${sql.insert({
        message_id: `message-${input.id}`,
        thread_id: input.threadId,
        run_id: `run-${input.id}`,
        role: "user",
        streaming: 0,
        created_at: input.startedAt,
        updated_at: input.startedAt,
        payload_json: encodeJson(input.message),
      })}`;
    }
    yield* sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert({
      run_id: `run-${input.id}`,
      thread_id: input.threadId,
      ordinal: input.ordinal,
      provider: "claudeAgent",
      provider_thread_id: providerThreadId,
      status: "completed",
      requested_at: input.startedAt,
      payload_json: encodeJson({ userMessageId: `message-${input.id}` }),
    })}`;
    yield* sql`INSERT INTO orchestration_v2_projection_run_attempts ${sql.insert({
      attempt_id: `attempt-${input.id}`,
      thread_id: input.threadId,
      run_id: `run-${input.id}`,
      attempt_ordinal: 1,
      root_node_id: `node-${input.id}`,
      provider: "claudeAgent",
      provider_thread_id: providerThreadId,
      status: "completed",
      payload_json: "{}",
    })}`;
    yield* sql`INSERT INTO orchestration_v2_projection_provider_turns ${sql.insert({
      provider_turn_id: `turn-${input.id}`,
      thread_id: input.threadId,
      provider_thread_id: providerThreadId,
      node_id: `node-${input.id}`,
      run_attempt_id: `attempt-${input.id}`,
      ordinal: input.ordinal,
      status: "completed",
      started_at: input.startedAt,
      completed_at: input.completedAt ?? null,
      payload_json: "{}",
    })}`;
  });

describe("UsageOrigins.read", () => {
  it.effect("joins each provider turn to its run's starting message and counts prompts", () =>
    Effect.gen(function* () {
      yield* seedThread({ id: "lead" });
      yield* seedThread({ id: "worker", crewOf: "lead" });
      yield* seedRun({
        id: "phone",
        ordinal: 1,
        threadId: "lead",
        sessionId: "lead-session",
        startedAt: "2026-08-07T01:00:00.000Z",
        completedAt: "2026-08-07T01:10:00.000Z",
        message: {
          createdBy: "user",
          creationSource: "web",
          origin: { surface: "web", deviceType: "mobile" },
        },
      });
      yield* seedRun({
        id: "brief",
        ordinal: 1,
        threadId: "worker",
        sessionId: "worker-session",
        startedAt: "2026-08-07T01:05:00.000Z",
        message: {
          createdBy: "agent",
          creationSource: "mcp",
          origin: { surface: "mcp", deviceType: "bot" },
        },
      });
      yield* seedRun({
        id: "gone",
        ordinal: 2,
        threadId: "lead",
        sessionId: "lead-session",
        startedAt: "2026-08-07T02:00:00.000Z",
      });
      yield* seedRun({
        id: "before-window",
        ordinal: 3,
        threadId: "lead",
        sessionId: "old-session",
        startedAt: "2026-07-01T00:00:00.000Z",
        message: { createdBy: "user", creationSource: "web" },
      });
      // A note starts no run, so it is no prompt.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_messages ${sql.insert({
        message_id: "message-note",
        thread_id: "worker",
        run_id: null,
        role: "user",
        streaming: 0,
        created_at: "2026-08-07T03:00:00.000Z",
        updated_at: "2026-08-07T03:00:00.000Z",
        payload_json: encodeJson({
          createdBy: "agent",
          creationSource: "mcp",
          origin: { surface: "mcp", deviceType: "bot" },
          note: true,
        }),
      })}`;

      const origins = yield* UsageOrigins;
      const snapshot = yield* origins.read(
        Date.parse("2026-08-07T00:00:00.000Z"),
        Date.parse("2026-08-08T00:00:00.000Z"),
      );
      const index = new UsageOriginIndex(snapshot.turns);
      assert.deepStrictEqual(index.lookup("lead-session", Date.parse("2026-08-07T01:01:00Z")), {
        origin: "phone",
        basis: "stamp",
      });
      assert.deepStrictEqual(index.lookup("worker-session", Date.parse("2026-08-07T01:06:00Z")), {
        origin: "crew",
        basis: "stamp",
      });
      assert.deepStrictEqual(index.lookup("lead-session", Date.parse("2026-08-07T02:01:00Z")), {
        origin: "unknown",
        basis: "noPrompt",
      });
      assert.strictEqual(index.lookup("old-session", Date.parse("2026-07-01T00:01:00Z")), null);
      assert.deepStrictEqual(
        snapshot.prompts.map(({ key }) => `${key.origin}/${key.basis}`).toSorted(),
        ["crew/stamp", "phone/stamp"],
      );
    }).pipe(Effect.provide(usageOriginsLayer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
  );
});
