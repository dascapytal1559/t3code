import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

// Rows of T3's projections as the Usage origin tests seed them.

export const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const seedThread = Effect.fn("usageOriginsTestSeed.seedThread")(function* (input: {
  id: string;
  crewOf?: string;
  causedBy?: Record<string, string>;
  worktreePath?: string;
  rootThreadId?: string;
  environment?: Record<string, string>;
  createdAt?: string;
  coordinator?: true;
  usageOrigin?: Record<string, unknown> | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({
    thread_id: input.id,
    project_id: "project",
    title: input.id,
    default_provider: "claudeAgent",
    runtime_mode: "full-access",
    interaction_mode: "default",
    created_at: input.createdAt ?? "2026-08-07T00:00:00.000Z",
    updated_at: input.createdAt ?? "2026-08-07T00:00:00.000Z",
    payload_json: encodeJson({
      id: input.id,
      crewOf: input.crewOf ?? null,
      worktreePath: input.worktreePath ?? null,
      ...(input.environment === undefined ? {} : { environment: input.environment }),
      ...(input.coordinator === undefined ? {} : { coordinator: input.coordinator }),
      ...(input.causedBy === undefined ? {} : { causedBy: input.causedBy }),
      ...(input.usageOrigin === undefined ? {} : { usageOrigin: input.usageOrigin }),
      ...(input.rootThreadId === undefined
        ? {}
        : { lineage: { rootThreadId: input.rootThreadId } }),
    }),
  })}`;
});

export const seedRun = Effect.fn("usageOriginsTestSeed.seedRun")(function* (input: {
  id: string;
  ordinal: number;
  threadId: string;
  sessionId: string;
  startedAt: string;
  completedAt?: string;
  message?: Record<string, unknown>;
}) {
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
    completed_at: input.completedAt ?? null,
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

export const seedMessage = Effect.fn("usageOriginsTestSeed.seedMessage")(function* (input: {
  id: string;
  threadId: string;
  runId: string;
  createdAt: string;
  payload: Record<string, unknown>;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_messages ${sql.insert({
    message_id: input.id,
    thread_id: input.threadId,
    run_id: input.runId,
    role: "user",
    streaming: 0,
    created_at: input.createdAt,
    updated_at: input.createdAt,
    payload_json: encodeJson(input.payload),
  })}`;
});
