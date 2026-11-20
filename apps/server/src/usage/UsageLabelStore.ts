import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import * as UsageClose from "./UsageClose.ts";
import type { OriginEntry, OriginRecord, UsageOriginKey } from "./UsageOrigins.ts";

/** Labels are written from `fromMs` (where the close's rows ended when writing began) through `throughMs`. */
export interface LabelCursor {
  readonly fromMs: number;
  readonly throughMs: number;
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** The born labels' tables: written by `UsageLabels`, read back to check the close against. */
export const makeLabelStore = (sql: SqlClient.SqlClient) => {
  const { sessionLabels, latestLabel, promptLabels } = UsageClose.makeLabelTables(sql, {
    sessions: "usage_session_labels",
    prompts: "usage_prompt_labels",
  });

  const cursor = sql<{ readonly labelled_from_ms: number; readonly labelled_through_ms: number }>`
    SELECT labelled_from_ms, labelled_through_ms FROM usage_label_cursor WHERE id = 1
  `.pipe(
    NodeSqliteClient.readOnly,
    Effect.map(([row]): LabelCursor | null =>
      row === undefined
        ? null
        : { fromMs: row.labelled_from_ms, throughMs: row.labelled_through_ms },
    ),
  );

  const setCursor = (next: LabelCursor, updatedAt: string) => sql`
    INSERT INTO usage_label_cursor (id, labelled_from_ms, labelled_through_ms, updated_at)
    VALUES (1, ${next.fromMs}, ${next.throughMs}, ${updatedAt})
    ON CONFLICT (id) DO UPDATE SET
      labelled_through_ms = excluded.labelled_through_ms,
      updated_at = excluded.updated_at
  `;

  /** A session's rows in (afterMs, lastMs] become these; the caller holds the transaction. */
  const replaceSessionRows = Effect.fn("UsageLabelStore.replaceSessionRows")(function* (
    sessionId: string,
    afterMs: number,
    lastMs: number,
    rows: readonly UsageClose.ClosedSessionLabel[],
  ) {
    yield* sql`
      DELETE FROM usage_session_labels
      WHERE session_id = ${sessionId} AND from_ms > ${afterMs} AND from_ms <= ${lastMs}
    `;
    for (const chunk of Arr.chunksOf(rows.map(UsageClose.sessionRowOf), UsageClose.INSERT_CHUNK)) {
      yield* sql`INSERT OR REPLACE INTO usage_session_labels ${sql.insert(chunk)}`;
    }
  });

  const writePrompts = Effect.fn("UsageLabelStore.writePrompts")(function* (
    prompts: readonly UsageClose.ClosedPromptLabel[],
  ) {
    for (const chunk of Arr.chunksOf(
      prompts.map(UsageClose.promptRowOf),
      UsageClose.INSERT_CHUNK,
    )) {
      yield* sql`INSERT OR REPLACE INTO usage_prompt_labels ${sql.insert(chunk)}`;
    }
  });

  /**
   * A work thread's timeline: entries after `afterMs` are written again, earlier ones only added
   * where missing, so a thread first labelled late still gets its birth.
   */
  const writeWork = Effect.fn("UsageLabelStore.writeWork")(function* (
    threadId: string,
    entries: readonly OriginEntry[],
    afterMs: number,
  ) {
    // Of entries at one time, the last is the one a lookup at that time finds.
    const byStart = new Map(entries.map((entry) => [entry.startedAtMs, entry]));
    const rows = [...byStart.values()].map((entry) => ({
      thread_id: threadId,
      from_ms: entry.startedAtMs,
      ...UsageClose.columnsOf(
        entry.via === undefined ? entry.key : { ...entry.key, via: entry.via },
      ),
      run_id: entry.runId,
      typed: entry.typed === true ? 1 : 0,
    }));
    yield* sql`DELETE FROM usage_work_labels WHERE thread_id = ${threadId} AND from_ms > ${afterMs}`;
    for (const chunk of Arr.chunksOf(rows, UsageClose.INSERT_CHUNK)) {
      yield* sql`INSERT OR IGNORE INTO usage_work_labels ${sql.insert(chunk)}`;
    }
  });

  /** Registrations whose session has no row from its start on. */
  const unlabelled = Effect.fn("UsageLabelStore.unlabelled")(function* <
    R extends { readonly sessionId: string; readonly startedAtMs: number },
  >(registrations: readonly R[]) {
    if (registrations.length === 0) return [];
    const wanted = registrations.map((entry) => ({ s: entry.sessionId, f: entry.startedAtMs }));
    const labelled = yield* sql<{ readonly session_id: string; readonly from_ms: number }>`
      SELECT json_extract(wanted.value, '$.s') AS session_id,
        json_extract(wanted.value, '$.f') AS from_ms
      FROM json_each(${encodeJson(wanted)}) AS wanted
      WHERE EXISTS (
        SELECT 1 FROM usage_session_labels AS label
        WHERE label.session_id = json_extract(wanted.value, '$.s')
          AND label.from_ms >= json_extract(wanted.value, '$.f')
      )
    `.pipe(NodeSqliteClient.readOnly);
    const done = new Set(labelled.map((row) => `${row.session_id}\0${row.from_ms}`));
    return registrations.filter((entry) => !done.has(`${entry.sessionId}\0${entry.startedAtMs}`));
  });

  /**
   * Threads where something that decides a label happened in (afterMs, throughMs]: a turn
   * started or ended (turns from `turnsAfterMs`), a prompt arrived on it or about it (a reply on
   * its box), or it was created.
   */
  const activeThreads = Effect.fn("UsageLabelStore.activeThreads")(function* (input: {
    readonly afterMs: number;
    readonly throughMs: number;
    readonly turnsAfterMs: number;
  }) {
    const after = iso(input.afterMs);
    const through = iso(input.throughMs);
    const turnsAfter = iso(input.turnsAfterMs);
    const rows = yield* sql<{ readonly thread_id: string | null }>`
      SELECT thread_id FROM orchestration_v2_projection_provider_turns
      WHERE (started_at > ${turnsAfter} AND started_at <= ${through})
        OR (completed_at >= ${after} AND completed_at <= ${through})
      UNION
      SELECT thread_id FROM orchestration_v2_projection_messages
      WHERE role = 'user' AND created_at > ${after} AND created_at <= ${through}
      UNION
      SELECT json_extract(payload_json, '$.crewNote.threadId') FROM orchestration_v2_projection_messages
      WHERE role = 'user' AND created_at > ${after} AND created_at <= ${through}
        AND json_extract(payload_json, '$.crewNote.threadId') IS NOT NULL
      UNION
      SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE created_at > ${after} AND created_at <= ${through}
    `.pipe(NodeSqliteClient.readOnly);
    return rows.flatMap((row) => (row.thread_id === null ? [] : [row.thread_id]));
  });

  /** Runs named in (afterMs, throughMs] while they ran, with their thread and first turn's start. */
  const namedRuns = Effect.fn("UsageLabelStore.namedRuns")(function* (
    afterMs: number,
    throughMs: number,
  ) {
    const rows = yield* sql<{ readonly thread_id: string; readonly started_at: string | null }>`
      SELECT run.thread_id, MIN(turn.started_at) AS started_at
      FROM usage_claims AS claim
      JOIN orchestration_v2_projection_runs AS run ON run.run_id = claim.target
      JOIN orchestration_v2_projection_run_attempts AS attempt ON attempt.run_id = run.run_id
      JOIN orchestration_v2_projection_provider_turns AS turn
        ON turn.run_attempt_id = attempt.attempt_id
      WHERE claim.target_kind = 'run'
        AND claim.claimed_at > ${iso(afterMs)} AND claim.claimed_at <= ${iso(throughMs)}
        AND (run.completed_at IS NULL OR claim.claimed_at <= run.completed_at)
      GROUP BY run.run_id
    `.pipe(NodeSqliteClient.readOnly);
    return rows.flatMap((row) => {
      const startedAtMs = row.started_at === null ? Number.NaN : Date.parse(row.started_at);
      return Number.isNaN(startedAtMs) ? [] : [{ threadId: row.thread_id, startedAtMs }];
    });
  });

  /** A run's thread and first turn's start, and whether it ended. */
  const run = Effect.fn("UsageLabelStore.run")(function* (runId: string) {
    const [row] = yield* sql<{
      readonly thread_id: string;
      readonly completed_at: string | null;
      readonly started_at: string | null;
    }>`
      SELECT run.thread_id, run.completed_at, MIN(turn.started_at) AS started_at
      FROM orchestration_v2_projection_runs AS run
      LEFT JOIN orchestration_v2_projection_run_attempts AS attempt ON attempt.run_id = run.run_id
      LEFT JOIN orchestration_v2_projection_provider_turns AS turn
        ON turn.run_attempt_id = attempt.attempt_id
      WHERE run.run_id = ${runId}
      GROUP BY run.run_id
    `.pipe(NodeSqliteClient.readOnly);
    if (row === undefined || row.started_at === null) return undefined;
    return {
      threadId: row.thread_id,
      startedAtMs: Date.parse(row.started_at),
      ended: row.completed_at !== null,
    };
  });

  return {
    cursor,
    setCursor,
    sessionLabels,
    promptLabels,
    latestLabel,
    replaceSessionRows,
    writePrompts,
    writeWork,
    unlabelled,
    activeThreads,
    namedRuns,
    run,
  };
};

/** How born labels compared with the labels a close worked out for the same records. */
export interface BornCheck {
  readonly records: number;
  readonly differingRecords: number;
  /** Records whose session has no born label, such as a terminal session T3 never registered. */
  readonly unbornRecords: number;
  readonly prompts: number;
  readonly differingPrompts: number;
  /** Differences by the close's reason and the born row's (`none` when it has none). */
  readonly byReason: Readonly<Record<string, number>>;
}

const reasonOf = (key: UsageOriginKey | undefined) =>
  key === undefined
    ? "none"
    : [
        key.origin,
        key.reason,
        ...(key.claim === undefined ? [] : [`${key.claim} claim`]),
        ...(key.registered === true ? ["registered"] : []),
        ...(key.folder === true ? ["folder"] : []),
        ...(key.cause === true ? ["cause"] : []),
      ].join(" ");

/**
 * Compares each record's born label (its session's latest row at or before it) and each prompt's
 * with what the close worked out, by every stored column, counting differences by reason.
 */
export function checkBorn(input: {
  readonly born: UsageClose.ClosedLabels;
  readonly derived: (record: OriginRecord) => UsageOriginKey;
  readonly records: readonly OriginRecord[];
  readonly bornPrompts: readonly UsageClose.ClosedPromptLabel[];
  readonly derivedPrompts: readonly UsageClose.ClosedPromptLabel[];
}): BornCheck {
  const byReason: Record<string, number> = {};
  const count = (
    kind: "record" | "prompt",
    derived: UsageOriginKey | undefined,
    born: UsageOriginKey | undefined,
  ) => {
    const reason = `${kind}: ${reasonOf(derived)} -> ${reasonOf(born)}`;
    byReason[reason] = (byReason[reason] ?? 0) + 1;
  };
  let differingRecords = 0;
  let unbornRecords = 0;
  for (const record of input.records) {
    const derived = input.derived(record);
    const born = input.born.labelAt(record);
    if (born === undefined) {
      unbornRecords++;
      continue;
    }
    if (UsageClose.sameKey(derived, born)) continue;
    differingRecords++;
    count("record", derived, born);
  }
  const bornPrompts = new Map(input.bornPrompts.map((prompt) => [prompt.messageId, prompt.key]));
  let differingPrompts = 0;
  for (const prompt of input.derivedPrompts) {
    const born = bornPrompts.get(prompt.messageId);
    if (UsageClose.sameKey(prompt.key, born)) continue;
    differingPrompts++;
    count("prompt", prompt.key, born);
  }
  return {
    records: input.records.length,
    differingRecords,
    unbornRecords,
    prompts: input.derivedPrompts.length,
    differingPrompts,
    byReason,
  };
}
