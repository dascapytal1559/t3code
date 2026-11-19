// @effect-diagnostics-next-line nodeBuiltinImport:off -- A synchronous digest naming a manifest.
import * as NodeCrypto from "node:crypto";

import {
  UsageOrigin,
  UsageOriginBasis,
  UsageOriginClaimKind,
  UsageOriginReason,
  UsageOriginVia,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * An audited correction of labels the daily close wrote down: a manifest names each stored row,
 * the label it holds and the label it gets. Applying it backs up the closed tables, records every
 * old value as one change set, and changes exactly those rows; undoing restores them.
 */

const Bit = Schema.Literals([0, 1]);

/** A label as the closed tables store it, column for column. */
export const RelabelLabel = Schema.Struct({
  device: Schema.Literals(["phone", "computer"]),
  origin: UsageOrigin,
  basis: UsageOriginBasis,
  reason: UsageOriginReason,
  via: Schema.NullOr(UsageOriginVia),
  claim: Schema.NullOr(UsageOriginClaimKind),
  folder: Bit,
  registered: Bit,
  cause: Bit,
  root_thread_id: Schema.NullOr(Schema.String),
  root_message_id: Schema.NullOr(Schema.String),
});
export type RelabelLabel = typeof RelabelLabel.Type;

const RelabelChange = { old: RelabelLabel, new: RelabelLabel, why: Schema.String };

/** A session's label from `fromMs`, or one prompt's label. */
export const RelabelRow = Schema.Union([
  Schema.Struct({
    table: Schema.Literal("session"),
    sessionId: Schema.String,
    fromMs: Schema.Int,
    ...RelabelChange,
  }),
  Schema.Struct({ table: Schema.Literal("prompt"), messageId: Schema.String, ...RelabelChange }),
]);
export type RelabelRow = typeof RelabelRow.Type;

export const RelabelManifest = Schema.Struct({
  reason: Schema.String,
  rows: Schema.Array(RelabelRow),
});
export type RelabelManifest = typeof RelabelManifest.Type;

export const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(RelabelManifest));
const encodeRows = Schema.encodeSync(Schema.fromJsonString(Schema.Array(RelabelRow)));
const encodeBackup = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeRows = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(RelabelRow)));

export class RelabelRefused extends Schema.TaggedError<RelabelRefused>()("RelabelRefused", {
  detail: Schema.String,
}) {
  override get message(): string {
    return `Usage relabel refused: ${this.detail} Nothing was changed.`;
  }
}

/** What a row holds now, against the manifest. */
export type RowState = "toChange" | "alreadyNew" | "differs" | "missing" | "notClosed";

export interface RelabelPlan {
  readonly manifestSha256: string;
  readonly rows: number;
  readonly states: Readonly<Record<RowState, number>>;
  /** Rows by old device to new device, such as `phone>computer`. */
  readonly moves: Readonly<Record<string, number>>;
  /** A change set already applied from this same manifest and not undone. */
  readonly appliedAs: string | null;
  /** The first rows that cannot be applied, for the report. */
  readonly problems: readonly string[];
}

export interface RelabelRecord {
  readonly id: string;
  readonly appliedAt: string;
  readonly reason: string;
  readonly manifestSha256: string;
  readonly rows: number;
  readonly undoneAt: string | null;
}

const LABEL_COLUMNS = [
  "device",
  "origin",
  "basis",
  "reason",
  "via",
  "claim",
  "folder",
  "registered",
  "cause",
  "root_thread_id",
  "root_message_id",
] as const;
const labelSelect = LABEL_COLUMNS.join(", ");

type StoredRow = { readonly [column in (typeof LABEL_COLUMNS)[number]]: unknown } & {
  readonly at_ms: number;
};

const sameLabel = (stored: StoredRow, label: RelabelLabel) =>
  LABEL_COLUMNS.every((column) => stored[column] === label[column]);

const rowName = (row: RelabelRow) =>
  row.table === "session"
    ? `session ${row.sessionId} from ${row.fromMs}`
    : `prompt ${row.messageId}`;
const rowKey = (row: RelabelRow) =>
  row.table === "session" ? `s\0${row.sessionId}\0${row.fromMs}` : `p\0${row.messageId}`;

/** The manifest's identity: its reason and rows, however the file was formatted. */
const manifestSha256 = (manifest: RelabelManifest) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify([manifest.reason, encodeRows(manifest.rows)]))
    .digest("hex");

const PROBLEMS_SHOWN = 20;

const readRow = (sql: SqlClient.SqlClient, row: RelabelRow) =>
  row.table === "session"
    ? sql<StoredRow>`
        SELECT ${sql.literal(labelSelect)}, from_ms AS at_ms FROM usage_closed_session_labels
        WHERE session_id = ${row.sessionId} AND from_ms = ${row.fromMs}
      `
    : sql<StoredRow>`
        SELECT ${sql.literal(labelSelect)}, created_at_ms AS at_ms FROM usage_closed_prompt_labels
        WHERE message_id = ${row.messageId}
      `;

const hasRelabelTable = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_relabels'
  `.pipe(Effect.map((rows) => rows.length > 0));

/** Reads what each manifest row holds now; writes nothing, so it runs on a read-only database. */
export const planRelabel = Effect.fn("UsageRelabel.plan")(function* (manifest: RelabelManifest) {
  const sql = yield* SqlClient.SqlClient;
  const seen = new Set<string>();
  for (const row of manifest.rows) {
    if (seen.has(rowKey(row)))
      return yield* new RelabelRefused({ detail: `the manifest names ${rowName(row)} twice.` });
    seen.add(rowKey(row));
    for (const label of [row.old, row.new]) {
      if ((label.device === "phone") !== (label.origin === "phone"))
        return yield* new RelabelRefused({
          detail: `${rowName(row)} gives device ${label.device} to origin ${label.origin}.`,
        });
    }
  }
  const [span] = yield* sql<{ readonly from_ms: number; readonly through_ms: number }>`
    SELECT closed_from_ms AS from_ms, closed_through_ms AS through_ms FROM usage_close WHERE id = 1
  `;
  const sha = manifestSha256(manifest);
  const applied = (yield* hasRelabelTable(sql))
    ? yield* sql<{ readonly id: string }>`
        SELECT id FROM usage_relabels WHERE manifest_sha256 = ${sha} AND undone_at IS NULL
      `
    : [];
  const states: Record<RowState, number> = {
    toChange: 0,
    alreadyNew: 0,
    differs: 0,
    missing: 0,
    notClosed: 0,
  };
  const moves: Record<string, number> = {};
  const problems: string[] = [];
  for (const row of manifest.rows) {
    const [stored] = yield* readRow(sql, row);
    const state: RowState =
      stored === undefined
        ? "missing"
        : span === undefined || stored.at_ms < span.from_ms || stored.at_ms > span.through_ms
          ? "notClosed"
          : sameLabel(stored, row.old)
            ? "toChange"
            : sameLabel(stored, row.new)
              ? "alreadyNew"
              : "differs";
    states[state] += 1;
    if (state === "toChange") {
      const move = `${row.old.device}>${row.new.device}`;
      moves[move] = (moves[move] ?? 0) + 1;
    } else if (problems.length < PROBLEMS_SHOWN) {
      problems.push(`${rowName(row)}: ${state}`);
    }
  }
  return {
    manifestSha256: sha,
    rows: manifest.rows.length,
    states,
    moves,
    appliedAs: applied[0]?.id ?? null,
    problems,
  } satisfies RelabelPlan;
});

const writeLabel = Effect.fn("UsageRelabel.writeLabel")(function* (
  sql: SqlClient.SqlClient,
  row: RelabelRow,
  from: RelabelLabel,
  to: RelabelLabel,
) {
  const set = sql.update(to);
  const matches = sql.and(LABEL_COLUMNS.map((column) => sql`${sql(column)} IS ${from[column]}`));
  const changed =
    row.table === "session"
      ? yield* sql<{ readonly n: number }>`
            UPDATE usage_closed_session_labels SET ${set}
            WHERE session_id = ${row.sessionId} AND from_ms = ${row.fromMs} AND ${matches}
            RETURNING 1 AS n
          `
      : yield* sql<{ readonly n: number }>`
            UPDATE usage_closed_prompt_labels SET ${set}
            WHERE message_id = ${row.messageId} AND ${matches}
            RETURNING 1 AS n
          `;
  if (changed.length !== 1)
    return yield* new RelabelRefused({ detail: `${rowName(row)} changed while relabelling.` });
});

const BACKUP_TABLES = [
  "usage_close",
  "usage_closed_session_labels",
  "usage_closed_prompt_labels",
] as const;

/**
 * Backs up the closed tables to `backupDir`, then in one transaction changes every row from its old
 * label to its new one and records the change set. Refused unless every row holds its old label.
 */
export const applyRelabel = Effect.fn("UsageRelabel.apply")(function* (input: {
  readonly manifest: RelabelManifest;
  readonly backupDir: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const plan = yield* planRelabel(input.manifest);
  if (plan.appliedAs !== null)
    return yield* new RelabelRefused({
      detail: `this manifest is already applied as ${plan.appliedAs}; undo it first.`,
    });
  if (plan.rows === 0) return yield* new RelabelRefused({ detail: "the manifest has no rows." });
  if (plan.states.toChange !== plan.rows)
    return yield* new RelabelRefused({
      detail: `${plan.rows - plan.states.toChange} of ${plan.rows} rows do not hold their old label (${plan.problems.slice(0, 3).join("; ")}).`,
    });
  const appliedAt = DateTime.formatIso(yield* DateTime.now);
  // A manifest applied again after an undo gets the next number.
  const [counted] = yield* sql<{ readonly earlier: number }>`
    SELECT count(*) AS earlier FROM usage_relabels WHERE manifest_sha256 = ${plan.manifestSha256}
  `;
  const earlier = counted?.earlier ?? 0;
  const stamp = appliedAt.replace(/[-:.]/g, "").slice(0, 15);
  const id = `relabel-${stamp}-${plan.manifestSha256.slice(0, 8)}-${earlier + 1}`;
  const backupPath = path.join(input.backupDir, `${id}.backup.json`);
  const tables: Record<string, unknown> = {};
  for (const table of BACKUP_TABLES) {
    tables[table] = yield* sql`SELECT * FROM ${sql(table)} ORDER BY rowid`;
  }
  yield* fs.makeDirectory(input.backupDir, { recursive: true });
  yield* fs.writeFileString(backupPath, yield* encodeBackup({ id, takenAt: appliedAt, tables }));
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const row of input.manifest.rows) yield* writeLabel(sql, row, row.old, row.new);
      yield* sql`
        INSERT INTO usage_relabels
          (id, applied_at, reason, manifest_sha256, backup_path, rows_json, undone_at)
        VALUES (${id}, ${appliedAt}, ${input.manifest.reason}, ${plan.manifestSha256},
          ${backupPath}, ${encodeRows(input.manifest.rows)}, NULL)
      `;
    }),
  );
  return { id, backupPath, rows: plan.rows, moves: plan.moves };
});

/** Restores every row of a change set to its old label, refused if any row changed since. */
export const undoRelabel = Effect.fn("UsageRelabel.undo")(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  const [record] = (yield* hasRelabelTable(sql))
    ? yield* sql<{ readonly rows_json: string; readonly undone_at: string | null }>`
        SELECT rows_json, undone_at FROM usage_relabels WHERE id = ${id}
      `
    : [];
  if (record === undefined)
    return yield* new RelabelRefused({ detail: `there is no change set ${id}.` });
  if (record.undone_at !== null)
    return yield* new RelabelRefused({
      detail: `${id} was already undone at ${record.undone_at}.`,
    });
  const rows = decodeRows(record.rows_json);
  const undoneAt = DateTime.formatIso(yield* DateTime.now);
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const row of rows) yield* writeLabel(sql, row, row.new, row.old);
      yield* sql`UPDATE usage_relabels SET undone_at = ${undoneAt} WHERE id = ${id}`;
    }),
  );
  return { id, rows: rows.length, undoneAt };
});

export const listRelabels = Effect.fn("UsageRelabel.list")(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* hasRelabelTable(sql))) return [];
  const rows = yield* sql<{
    readonly id: string;
    readonly applied_at: string;
    readonly reason: string;
    readonly manifest_sha256: string;
    readonly rows: number;
    readonly undone_at: string | null;
  }>`
    SELECT id, applied_at, reason, manifest_sha256, json_array_length(rows_json) AS rows, undone_at
    FROM usage_relabels ORDER BY applied_at
  `;
  return rows.map((row): RelabelRecord => ({
    id: row.id,
    appliedAt: row.applied_at,
    reason: row.reason,
    manifestSha256: row.manifest_sha256,
    rows: row.rows,
    undoneAt: row.undone_at,
  }));
});
