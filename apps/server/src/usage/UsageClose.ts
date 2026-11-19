import {
  USAGE_ORIGINS_RECORDED_SINCE,
  UsageOrigin,
  UsageOriginBasis,
  UsageOriginClaimKind,
  UsageOriginReason,
  UsageOriginVia,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import type {
  OriginPrompt,
  OriginRecord,
  OriginTurn,
  UsageOriginIndex,
  UsageOriginKey,
} from "./UsageOrigins.ts";

/** Labels are closed from here on: before it, T3 recorded no devices to label by. */
export const CLOSE_FROM_MS = Date.parse(USAGE_ORIGINS_RECORDED_SINCE);
/** A close writes down everything older than this. */
export const CLOSE_AGE_MS = 24 * 60 * 60 * 1000;
/** A close is due once the open tail is longer than this. */
export const CLOSE_DUE_MS = 48 * 60 * 60 * 1000;

/** Labels at or before `throughMs` (and from `fromMs`) are read as stored. */
export interface ClosedSpan {
  readonly fromMs: number;
  readonly throughMs: number;
}

export const isClosed = (span: ClosedSpan | null, atMs: number) =>
  span !== null && atMs >= span.fromMs && atMs <= span.throughMs;

/** A session's label from a time until its next row, as a close wrote it down. */
export interface ClosedSessionLabel {
  readonly sessionId: string;
  readonly fromMs: number;
  readonly key: UsageOriginKey;
  /** The run of the turn it fell in; null outside the session's turns. */
  readonly runId: string | null;
  /** Decided by a prompt typed in that turn (or a voice journal): work bound from it re-roots. */
  readonly typed: boolean;
}

export interface ClosedPromptLabel extends OriginPrompt {
  readonly messageId: string;
}

// A type, not an interface, so a row of it is a SQL insert record.
export type LabelColumns = {
  readonly device: "phone" | "computer";
  readonly origin: string;
  readonly basis: string;
  readonly reason: string;
  readonly via: string | null;
  readonly claim: string | null;
  readonly folder: number;
  readonly registered: number;
  readonly cause: number;
  readonly root_thread_id: string | null;
  readonly root_message_id: string | null;
};

export const columnsOf = (key: UsageOriginKey): LabelColumns => ({
  device: key.origin === "phone" ? "phone" : "computer",
  origin: key.origin,
  basis: key.basis,
  reason: key.reason,
  via: key.via ?? null,
  claim: key.claim ?? null,
  folder: key.folder === true ? 1 : 0,
  registered: key.registered === true ? 1 : 0,
  cause: key.cause === true ? 1 : 0,
  root_thread_id: key.root?.threadId ?? null,
  root_message_id: key.root?.messageId ?? null,
});

const isOrigin = Schema.is(UsageOrigin);
const isBasis = Schema.is(UsageOriginBasis);
const isReason = Schema.is(UsageOriginReason);
const isVia = Schema.is(UsageOriginVia);
const isClaimKind = Schema.is(UsageOriginClaimKind);

/** A row with a word this version does not know is left out, so its records read live. */
const keyOf = (row: LabelColumns): UsageOriginKey | undefined => {
  const { origin, basis, reason, via, claim } = row;
  if (!isOrigin(origin) || !isBasis(basis) || !isReason(reason)) return undefined;
  if ((via !== null && !isVia(via)) || (claim !== null && !isClaimKind(claim))) return undefined;
  return {
    origin,
    basis,
    reason,
    ...(via === null ? {} : { via }),
    ...(claim === null ? {} : { claim }),
    ...(row.folder === 1 ? { folder: true as const } : {}),
    ...(row.registered === 1 ? { registered: true as const } : {}),
    ...(row.cause === 1 ? { cause: true as const } : {}),
    ...(row.root_thread_id === null || row.root_message_id === null
      ? {}
      : { root: { threadId: row.root_thread_id, messageId: row.root_message_id } }),
  };
};

/** Two labels are the same when every stored column is. */
export const sameKey = (a: UsageOriginKey | undefined, b: UsageOriginKey | undefined) =>
  a === undefined || b === undefined
    ? a === b
    : JSON.stringify(columnsOf(a)) === JSON.stringify(columnsOf(b));

/** Two rows say the same when their run, typed flag and label do. */
export const sameRow = (a: ClosedSessionLabel, b: ClosedSessionLabel) =>
  a.runId === b.runId && a.typed === b.typed && sameKey(a.key, b.key);

/** The last item from at or before the time; items are sorted by `fromMs`. */
function latestAt<T extends { readonly fromMs: number }>(items: readonly T[], atMs: number) {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle]!.fromMs <= atMs) low = middle + 1;
    else high = middle;
  }
  return items[low - 1];
}

/**
 * Each session's labels over (afterMs, throughMs], a row each time its label changes: read at every
 * usage record, and at each of its turns' segments and ends, so binding at a closed time can be
 * answered from the rows too.
 */
export function closedSessionLabels(
  index: UsageOriginIndex,
  turns: readonly OriginTurn[],
  records: readonly OriginRecord[],
  afterMs: number,
  throughMs: number,
): ClosedSessionLabel[] {
  const inSpan = (atMs: number) => atMs > afterMs && atMs <= throughMs;
  const points = new Map<string, OriginRecord[]>();
  const add = (point: OriginRecord) => {
    if (!inSpan(point.timestampMs)) return;
    const list = points.get(point.sessionId);
    if (list === undefined) points.set(point.sessionId, [point]);
    else list.push(point);
  };
  for (const record of records) add(record);
  for (const turn of turns) {
    add({ sessionId: turn.sessionId, timestampMs: turn.startedAtMs });
    if (turn.completedAtMs !== null)
      add({ sessionId: turn.sessionId, timestampMs: turn.completedAtMs + 1 });
  }
  const rows: ClosedSessionLabel[] = [];
  for (const [sessionId, list] of points) {
    list.sort((a, b) => a.timestampMs - b.timestampMs);
    let last: ClosedSessionLabel | undefined;
    let lastAtMs = Number.NEGATIVE_INFINITY;
    for (const point of list) {
      // One label per time: a record there labelled otherwise reads the first one's label.
      if (point.timestampMs === lastAtMs) continue;
      lastAtMs = point.timestampMs;
      const turn = index.turnAt(point);
      const row: ClosedSessionLabel = {
        sessionId,
        fromMs: point.timestampMs,
        key: index.lookup(point),
        runId: turn?.runId ?? null,
        typed: turn?.typed === true,
      };
      if (last !== undefined && sameRow(last, row)) continue;
      rows.push(row);
      last = row;
    }
  }
  return rows;
}

/** Sessions' stored labels: a record takes the latest row at or before its time. */
export class ClosedLabels {
  readonly #bySession = new Map<string, ClosedSessionLabel[]>();

  constructor(rows: readonly ClosedSessionLabel[]) {
    for (const row of rows) {
      const list = this.#bySession.get(row.sessionId);
      if (list === undefined) this.#bySession.set(row.sessionId, [row]);
      else list.push(row);
    }
    for (const list of this.#bySession.values()) list.sort((a, b) => a.fromMs - b.fromMs);
  }

  /** Undefined when the session has no row by then: a transcript found after its day closed. */
  labelAt(record: OriginRecord): UsageOriginKey | undefined {
    const rows = this.#bySession.get(record.sessionId);
    return rows === undefined ? undefined : latestAt(rows, record.timestampMs)?.key;
  }
}

/**
 * The records whose stored label is not the label they were closed with. Records of one session
 * at one time with different labels have one row between them, so they are not compared.
 */
export const differingRecords = (
  stored: ClosedLabels,
  index: UsageOriginIndex,
  records: readonly OriginRecord[],
) => {
  const at = (record: OriginRecord) => `${record.sessionId}\0${record.timestampMs}`;
  const labelled = records.map((record) => ({ record, key: index.lookup(record) }));
  const first = new Map<string, UsageOriginKey>();
  const shared = new Set<string>();
  for (const { record, key } of labelled) {
    const seen = first.get(at(record));
    if (seen === undefined) first.set(at(record), key);
    else if (!sameKey(seen, key)) shared.add(at(record));
  }
  return labelled.filter(
    ({ record, key }) => !shared.has(at(record)) && !sameKey(stored.labelAt(record), key),
  );
};

export class ClosedLabelsDiffer extends Schema.TaggedError<ClosedLabelsDiffer>()(
  "ClosedLabelsDiffer",
  { records: Schema.Number, prompts: Schema.Number },
) {
  override get message(): string {
    return `Usage did not close: ${this.records} records and ${this.prompts} prompts read back differently.`;
  }
}

export class CloseSuperseded extends Schema.TaggedError<CloseSuperseded>()("CloseSuperseded", {}) {}

const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

// SQLite caps bound parameters per statement; a row binds at most 15.
export const INSERT_CHUNK = 500;

const labelSelect = `device, origin, basis, reason, via, claim, folder, registered, cause,
  root_thread_id, root_message_id`;

type SessionRow = LabelColumns & {
  readonly session_id: string;
  readonly from_ms: number;
  readonly run_id: string | null;
  readonly typed: number;
};

const sessionLabelOf = (row: SessionRow): ClosedSessionLabel[] => {
  const key = keyOf(row);
  return key === undefined
    ? []
    : [
        {
          sessionId: row.session_id,
          fromMs: row.from_ms,
          key,
          runId: row.run_id,
          typed: row.typed === 1,
        },
      ];
};

// A type, not an interface, so a row of it is a SQL insert record.
type PromptRow = LabelColumns & {
  readonly message_id: string;
  readonly thread_id: string | null;
  readonly created_at_ms: number;
};

const promptLabelOf = (row: PromptRow): ClosedPromptLabel[] => {
  const key = keyOf(row);
  return key === undefined
    ? []
    : [
        {
          messageId: row.message_id,
          createdAtMs: row.created_at_ms,
          key,
          ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
        },
      ];
};

/** A session row as stored. */
export const sessionRowOf = (row: ClosedSessionLabel) => ({
  session_id: row.sessionId,
  from_ms: row.fromMs,
  ...columnsOf(row.key),
  run_id: row.runId,
  typed: row.typed ? 1 : 0,
});

/** A prompt row as stored. */
export const promptRowOf = (prompt: ClosedPromptLabel): PromptRow => ({
  message_id: prompt.messageId,
  thread_id: prompt.threadId ?? null,
  created_at_ms: prompt.createdAtMs,
  ...columnsOf(prompt.key),
});

/**
 * Readers of a pair of label tables in the close's shape: a session's label from each time it
 * changes, and each prompt's. The daily close's tables and the born labels' share it.
 */
export const makeLabelTables = (
  sql: SqlClient.SqlClient,
  tables: { readonly sessions: string; readonly prompts: string },
) => {
  const sessionColumns = sql.literal(`session_id, from_ms, ${labelSelect}, run_id, typed`);
  const sessionTable = sql.literal(tables.sessions);
  const promptTable = sql.literal(tables.prompts);

  /** The labels of these sessions up to a time. */
  const sessionLabels = (sessionIds: readonly string[], untilMs: number) =>
    sessionIds.length === 0
      ? Effect.succeed([])
      : sql<SessionRow>`
          SELECT ${sessionColumns} FROM ${sessionTable}
          WHERE session_id IN (SELECT value FROM json_each(${encodeIds(sessionIds)}))
            AND from_ms <= ${untilMs}
        `.pipe(
          NodeSqliteClient.readOnly,
          Effect.map((rows) => rows.flatMap(sessionLabelOf)),
        );

  /** A session's latest label at or before `atMs`, from `sinceMs` on. */
  const latestLabel = (sessionId: string, atMs: number, sinceMs: number) =>
    sql<SessionRow>`
      SELECT ${sessionColumns} FROM ${sessionTable}
      WHERE session_id = ${sessionId} AND from_ms <= ${atMs} AND from_ms >= ${sinceMs}
      ORDER BY from_ms DESC LIMIT 1
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.map((rows) => rows.flatMap(sessionLabelOf)[0]),
    );

  /** A thread's own sessions' latest labels at or before a time, newest first. */
  const threadLabels = (threadId: string, atMs: number) =>
    sql<SessionRow>`
      SELECT ${sessionColumns} FROM ${sessionTable}
      WHERE from_ms <= ${atMs} AND session_id IN (
        SELECT json_extract(payload_json, '$.nativeThreadRef.nativeId')
        FROM orchestration_v2_projection_provider_threads WHERE thread_id = ${threadId}
      )
      ORDER BY from_ms DESC LIMIT 64
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.map((rows) => rows.flatMap(sessionLabelOf)),
    );

  /** Prompts labelled in [sinceMs, untilMs). */
  const promptLabels = (sinceMs: number, untilMs: number) =>
    sql<PromptRow>`
      SELECT message_id, thread_id, created_at_ms, ${sql.literal(labelSelect)}
      FROM ${promptTable}
      WHERE created_at_ms >= ${sinceMs} AND created_at_ms < ${untilMs}
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.map((rows) => rows.flatMap(promptLabelOf)),
    );

  return { sessionLabels, latestLabel, threadLabels, promptLabels };
};

/** The closed labels' tables, as the Usage origin reader uses them. */
export const makeClosedStore = (sql: SqlClient.SqlClient) => {
  const { sessionLabels, threadLabels, promptLabels } = makeLabelTables(sql, {
    sessions: "usage_closed_session_labels",
    prompts: "usage_closed_prompt_labels",
  });

  const span = sql<{ readonly closed_from_ms: number; readonly closed_through_ms: number }>`
    SELECT closed_from_ms, closed_through_ms FROM usage_close WHERE id = 1
  `.pipe(
    NodeSqliteClient.readOnly,
    Effect.map(([row]): ClosedSpan | null =>
      row === undefined ? null : { fromMs: row.closed_from_ms, throughMs: row.closed_through_ms },
    ),
  );

  /** Writes a close's rows and moves "closed through"; the caller holds the transaction. */
  const write = Effect.fn("UsageClose.write")(function* (input: {
    readonly span: ClosedSpan;
    readonly closedAt: string;
    readonly sessions: readonly ClosedSessionLabel[];
    readonly prompts: readonly ClosedPromptLabel[];
  }) {
    const sessionRows = input.sessions.map(sessionRowOf);
    for (const chunk of Arr.chunksOf(sessionRows, INSERT_CHUNK)) {
      yield* sql`INSERT INTO usage_closed_session_labels ${sql.insert(chunk)}`;
    }
    const promptRows = input.prompts.map(promptRowOf);
    for (const chunk of Arr.chunksOf(promptRows, INSERT_CHUNK)) {
      yield* sql`INSERT INTO usage_closed_prompt_labels ${sql.insert(chunk)}`;
    }
    yield* sql`
      INSERT INTO usage_close (id, closed_from_ms, closed_through_ms, closed_at)
      VALUES (1, ${input.span.fromMs}, ${input.span.throughMs}, ${input.closedAt})
      ON CONFLICT (id) DO UPDATE SET
        closed_through_ms = excluded.closed_through_ms,
        closed_at = excluded.closed_at
    `;
  });

  return { span, sessionLabels, threadLabels, promptLabels, write };
};
