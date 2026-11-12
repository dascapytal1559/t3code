import type { UsageOrigin, UsageOriginBasis, UsageOriginVia } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export interface UsageOriginKey {
  readonly origin: UsageOrigin;
  readonly basis: UsageOriginBasis;
  /** Set when the origin is the root of a recorded cause chain: who sent the prompt itself. */
  readonly via?: UsageOriginVia;
}

/** The stored provenance of one message; null fields were never recorded. */
export interface OriginMessage {
  readonly createdBy: string | null;
  readonly creationSource: string | null;
  readonly surface: string | null;
  readonly deviceType: string | null;
  /** The message's thread is FirstMate crew (`crewOf`). */
  readonly crew: boolean;
}

/** A message and the prompt recorded as its cause: its own `causedBy`, else its thread's. */
export interface CausalMessage extends OriginMessage {
  readonly id: string;
  readonly causedBy: string | null;
}

/** Reads only what T3 recorded; an older message without a stamp is never upgraded to a device. */
export function classifyMessageOrigin(message: OriginMessage): UsageOriginKey {
  const key = recordedOrigin(message);
  return key.origin === "agent" && message.crew ? { ...key, origin: "crew" } : key;
}

function recordedOrigin(message: OriginMessage): UsageOriginKey {
  const { surface, deviceType } = message;
  if (surface !== null || deviceType !== null) {
    if (surface === "mcp" || deviceType === "bot") return { origin: "agent", basis: "stamp" };
    if (deviceType === "mobile" || deviceType === "tablet" || surface === "mobile") {
      return { origin: "phone", basis: "stamp" };
    }
    if (deviceType === "desktop" || surface === "desktop") {
      return { origin: "computer", basis: "stamp" };
    }
    return { origin: "unknown", basis: "stamp" };
  }
  if (message.creationSource === "mobile") return { origin: "phone", basis: "nativeApp" };
  if (
    message.createdBy === "agent" ||
    message.creationSource === "mcp" ||
    message.creationSource === "provider"
  ) {
    return { origin: "agent", basis: "sender" };
  }
  if (message.creationSource === "server") return { origin: "unknown", basis: "server" };
  return { origin: "unknown", basis: "unstamped" };
}

const sentByAgent = (key: UsageOriginKey): key is UsageOriginKey & { origin: UsageOriginVia } =>
  key.origin === "agent" || key.origin === "crew";

/** Hops followed from an agent prompt toward its root; longer or broken chains keep the prompt's own origin. */
export const MAX_CAUSE_DEPTH = 8;

/**
 * An agent prompt counts to the phone or computer prompt at the root of its recorded causes.
 * Any other root (an agent acting on its own, an unknown or server prompt), a missing message,
 * a cycle or a chain past MAX_CAUSE_DEPTH leaves the prompt's own origin.
 */
export function resolveMessageOrigin(
  message: CausalMessage,
  causeOf: (messageId: string) => CausalMessage | undefined,
): UsageOriginKey {
  const direct = classifyMessageOrigin(message);
  if (!sentByAgent(direct)) return direct;
  const seen = new Set([message.id]);
  let current = message;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    const causeId = current.causedBy;
    if (causeId === null || seen.has(causeId)) break;
    seen.add(causeId);
    const cause = causeOf(causeId);
    if (cause === undefined) break;
    const root = classifyMessageOrigin(cause);
    if (root.origin === "phone" || root.origin === "computer") {
      return { origin: root.origin, basis: root.basis, via: direct.origin };
    }
    if (!sentByAgent(root)) break;
    current = cause;
  }
  return direct;
}

const NO_PROMPT: UsageOriginKey = { origin: "unknown", basis: "noPrompt" };

/** A provider turn of one native session, keyed by the run's starting message. */
export interface OriginTurn {
  readonly sessionId: string;
  readonly startedAtMs: number;
  readonly completedAtMs: number | null;
  readonly key: UsageOriginKey;
}

export interface OriginPrompt {
  readonly createdAtMs: number;
  readonly key: UsageOriginKey;
}

export interface UsageOriginSnapshot {
  readonly turns: readonly OriginTurn[];
  readonly prompts: readonly OriginPrompt[];
}

// Records written this long after a turn ended belong to no T3 turn, such as a terminal resume.
const LATE_RECORD_GRACE_MS = 5 * 60 * 1000;

/** Matches a transcript record to the T3 turn of its native session that was running at the time. */
export class UsageOriginIndex {
  readonly #turnsBySession = new Map<string, OriginTurn[]>();

  constructor(turns: readonly OriginTurn[]) {
    for (const turn of turns) {
      const sessionTurns = this.#turnsBySession.get(turn.sessionId) ?? [];
      sessionTurns.push(turn);
      this.#turnsBySession.set(turn.sessionId, sessionTurns);
    }
    for (const sessionTurns of this.#turnsBySession.values()) {
      sessionTurns.sort((a, b) => a.startedAtMs - b.startedAtMs);
    }
  }

  lookup(sessionId: string, timestampMs: number): UsageOriginKey | null {
    const turns = this.#turnsBySession.get(sessionId);
    if (turns === undefined) return null;
    let low = 0;
    let high = turns.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (turns[middle]!.startedAtMs <= timestampMs) low = middle + 1;
      else high = middle;
    }
    const turn = turns[low - 1];
    if (turn === undefined) return null;
    if (turn.completedAtMs !== null && timestampMs > turn.completedAtMs + LATE_RECORD_GRACE_MS) {
      return null;
    }
    return turn.key;
  }
}

export class UsageOriginsReadError extends Schema.TaggedError<UsageOriginsReadError>()(
  "UsageOriginsReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the origins of T3 prompts.";
  }
}

export class UsageOrigins extends Context.Service<
  UsageOrigins,
  {
    readonly read: (
      sinceMs: number,
      untilMs: number,
    ) => Effect.Effect<UsageOriginSnapshot, UsageOriginsReadError>;
  }
>()("t3/usage/UsageOrigins") {}

interface MessageColumns {
  readonly message_id: string;
  readonly created_by: string | null;
  readonly creation_source: string | null;
  readonly surface: string | null;
  readonly device_type: string | null;
  readonly crew: number;
  readonly caused_by: string | null;
}

const messageOf = (row: MessageColumns): CausalMessage => ({
  id: row.message_id,
  createdBy: row.created_by,
  creationSource: row.creation_source,
  surface: row.surface,
  deviceType: row.device_type,
  crew: row.crew === 1,
  causedBy: row.caused_by,
});

const parseMs = (value: string | null): number | null => {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

const MessageIdList = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeMessageIds = Schema.encodeSync(MessageIdList);

// A turn that started before the window can still be running in it.
const TURN_LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Columns of `message` (joined to its `thread`) that classify it and name its cause.
  const messageColumns = sql.literal(`
    message.message_id,
    json_extract(message.payload_json, '$.createdBy') AS created_by,
    json_extract(message.payload_json, '$.creationSource') AS creation_source,
    json_extract(message.payload_json, '$.origin.surface') AS surface,
    json_extract(message.payload_json, '$.origin.deviceType') AS device_type,
    json_extract(thread.payload_json, '$.crewOf') IS NOT NULL AS crew,
    coalesce(
      json_extract(message.payload_json, '$.causedBy.messageId'),
      json_extract(thread.payload_json, '$.causedBy.messageId')
    ) AS caused_by`);

  // Loads the recorded causes of agent prompts, one chain hop per query.
  const loadCauses = Effect.fn("UsageOrigins.loadCauses")(function* (
    messages: ReadonlyArray<CausalMessage>,
  ) {
    const loaded = new Map<string, CausalMessage>();
    const causesToLoad = (from: ReadonlyArray<CausalMessage>) =>
      new Set(
        from.flatMap((message) =>
          message.causedBy !== null &&
          !loaded.has(message.causedBy) &&
          sentByAgent(classifyMessageOrigin(message))
            ? [message.causedBy]
            : [],
        ),
      );
    let pending = causesToLoad(messages);
    for (let depth = 0; depth < MAX_CAUSE_DEPTH && pending.size > 0; depth++) {
      const rows = yield* sql<MessageColumns>`
        SELECT ${messageColumns}
        FROM orchestration_v2_projection_messages AS message
        LEFT JOIN orchestration_v2_projection_threads AS thread
          ON thread.thread_id = message.thread_id
        WHERE message.message_id IN (SELECT value FROM json_each(${encodeMessageIds([...pending])}))
      `.pipe(NodeSqliteClient.readOnly);
      const found = rows.map(messageOf);
      for (const message of found) loaded.set(message.id, message);
      pending = causesToLoad(found);
    }
    return loaded;
  });

  const read = Effect.fn("UsageOrigins.read")(
    function* (sinceMs: number, untilMs: number) {
      const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
      const since = iso(sinceMs);
      const until = iso(untilMs);
      const turnsSince = iso(sinceMs - TURN_LOOKBACK_MS);
      // A run's sender is its userMessageId's origin; later steering messages do not split it.
      const turnRows = yield* sql<
        Omit<MessageColumns, "message_id"> & {
          readonly message_id: string | null;
          readonly session_id: string | null;
          readonly started_at: string | null;
          readonly completed_at: string | null;
        }
      >`
      SELECT json_extract(provider_thread.payload_json, '$.nativeThreadRef.nativeId') AS session_id,
        turn.started_at,
        turn.completed_at,
        ${messageColumns}
      FROM orchestration_v2_projection_provider_turns AS turn
      JOIN orchestration_v2_projection_provider_threads AS provider_thread
        ON provider_thread.provider_thread_id = turn.provider_thread_id
      LEFT JOIN orchestration_v2_projection_run_attempts AS attempt
        ON attempt.attempt_id = turn.run_attempt_id
      LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = attempt.run_id
      LEFT JOIN orchestration_v2_projection_messages AS message
        ON message.message_id = json_extract(run.payload_json, '$.userMessageId')
      LEFT JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = turn.thread_id
      WHERE turn.started_at >= ${turnsSince} AND turn.started_at < ${until}
    `.pipe(NodeSqliteClient.readOnly);
      const promptRows = yield* sql<MessageColumns & { readonly created_at: string }>`
      SELECT message.created_at, ${messageColumns}
      FROM orchestration_v2_projection_messages AS message
      LEFT JOIN orchestration_v2_projection_threads AS thread
        ON thread.thread_id = message.thread_id
      WHERE message.role = 'user' AND message.created_at >= ${since} AND message.created_at < ${until}
        AND json_extract(message.payload_json, '$.note') IS NULL
    `.pipe(NodeSqliteClient.readOnly);

      const turnMessages = turnRows.map((row) =>
        row.message_id === null ? null : messageOf({ ...row, message_id: row.message_id }),
      );
      const promptMessages = promptRows.map(messageOf);
      const causes = yield* loadCauses([
        ...turnMessages.filter((message) => message !== null),
        ...promptMessages,
      ]);
      const originOf = (message: CausalMessage) =>
        resolveMessageOrigin(message, (id) => causes.get(id));

      const turns: OriginTurn[] = [];
      turnRows.forEach((row, index) => {
        const startedAtMs = parseMs(row.started_at);
        if (row.session_id === null || startedAtMs === null) return;
        const message = turnMessages[index] ?? null;
        turns.push({
          sessionId: row.session_id,
          startedAtMs,
          completedAtMs: parseMs(row.completed_at),
          key: message === null ? NO_PROMPT : originOf(message),
        });
      });
      const prompts: OriginPrompt[] = [];
      promptRows.forEach((row, index) => {
        const createdAtMs = parseMs(row.created_at);
        if (createdAtMs !== null)
          prompts.push({ createdAtMs, key: originOf(promptMessages[index]!) });
      });
      return { turns, prompts } satisfies UsageOriginSnapshot;
    },
    Effect.mapError((cause) => new UsageOriginsReadError({ cause })),
  );

  return UsageOrigins.of({ read });
});

export const layer = Layer.effect(UsageOrigins, make);
