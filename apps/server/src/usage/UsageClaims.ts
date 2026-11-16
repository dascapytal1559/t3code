import { MessageId, type OrchestrationV2CausedBy, RunId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

/**
 * A provider session, by its native id, from a start time or whole; every session whose working
 * folder is inside a folder; or one T3 run (turn), whose run id the caller checked against its
 * thread.
 */
export type UsageClaimTarget =
  | { readonly kind: "session"; readonly sessionId: string; readonly from?: DateTime.Utc }
  | { readonly kind: "directory"; readonly directory: string }
  | { readonly kind: "run"; readonly runId: string };

export type UsageClaimDevice = "phone" | "computer";

/** How a device bound by value was read: the basis and reason of the work it was copied from. */
export interface UsageClaimBinding {
  readonly basis: string;
  readonly reason: string;
  readonly claim?: string;
  /** The typed prompt that decided it. */
  readonly root?: { readonly threadId: string; readonly messageId: string };
}

/**
 * What a claim counts its target to: the prompt that caused it, a device directly, or a device
 * bound by value from a thread's work, with how that work counted.
 */
export type UsageClaimValue =
  | { readonly causedBy: OrchestrationV2CausedBy }
  | { readonly device: UsageClaimDevice; readonly bound?: UsageClaimBinding };

export interface StoredUsageClaim {
  readonly kind: UsageClaimTarget["kind"];
  /** The session id, the resolved folder, or the run id. */
  readonly target: string;
  /** A session claim's start, in epoch ms; absent, it covers the whole session. */
  readonly fromMs?: number;
  readonly causeMessageId: string | null;
  readonly device: UsageClaimDevice | null;
  readonly bound?: UsageClaimBinding;
}

const BoundJson = Schema.fromJsonString(
  Schema.Struct({
    basis: Schema.String,
    reason: Schema.String,
    claim: Schema.optional(Schema.String),
    root: Schema.optional(Schema.Struct({ threadId: Schema.String, messageId: Schema.String })),
  }),
);
const encodeBound = Schema.encodeSync(BoundJson);
const decodeBoundOption = Schema.decodeOption(BoundJson);
const decodeBound = (json: string | null): UsageClaimBinding | undefined => {
  const decoded = json === null ? Option.none() : decodeBoundOption(json);
  if (Option.isNone(decoded)) return undefined;
  const { claim, root, ...binding } = decoded.value;
  return {
    ...binding,
    ...(claim === undefined ? {} : { claim }),
    ...(root === undefined ? {} : { root }),
  };
};

/**
 * Work Usage can't trace on its own, claimed by an agent: sessions run outside T3, or a turn whose
 * prompt has no cause (a wake). A session keeps one claim per start. Claiming again replaces the
 * value unless `ifUnclaimed` keeps the first (`kept`); null removes it. Folders are stored resolved.
 */
export class UsageClaims extends Context.Service<
  UsageClaims,
  {
    readonly claim: (input: {
      readonly target: UsageClaimTarget;
      readonly value: UsageClaimValue | null;
      readonly ifUnclaimed?: boolean;
    }) => Effect.Effect<
      {
        readonly target: UsageClaimTarget;
        readonly value: UsageClaimValue | null;
        readonly kept: boolean;
      },
      SqlError.SqlError
    >;
    readonly read: Effect.Effect<ReadonlyArray<StoredUsageClaim>, SqlError.SqlError>;
    /** The claims on these runs. */
    readonly readRuns: (
      runIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<StoredUsageClaim>, SqlError.SqlError>;
  }
>()("t3/usage/UsageClaims") {}

interface ClaimRow {
  readonly target_kind: string;
  readonly target: string;
  readonly claimed_from: string;
  readonly cause_message_id: string | null;
  readonly device: string | null;
  readonly bound_json: string | null;
}

interface StoredValueRow {
  readonly cause_thread_id: string | null;
  readonly cause_run_id: string | null;
  readonly cause_message_id: string | null;
  readonly device: string | null;
  readonly bound_json: string | null;
}

const storedValue = (row: StoredValueRow): UsageClaimValue | null => {
  const bound = decodeBound(row.bound_json);
  return row.device === "phone" || row.device === "computer"
    ? { device: row.device, ...(bound === undefined ? {} : { bound }) }
    : row.cause_thread_id === null || row.cause_message_id === null
      ? null
      : {
          causedBy: {
            threadId: ThreadId.make(row.cause_thread_id),
            messageId: MessageId.make(row.cause_message_id),
            ...(row.cause_run_id === null ? {} : { runId: RunId.make(row.cause_run_id) }),
          },
        };
};

// A claim with no start is stored from "", since SQLite never matches NULL keys on conflict.
const NO_START = "";
const claimedFrom = (target: UsageClaimTarget) =>
  target.kind === "session" && target.from !== undefined
    ? DateTime.formatIso(target.from)
    : NO_START;

const targetKey = (target: UsageClaimTarget) =>
  target.kind === "session"
    ? target.sessionId
    : target.kind === "directory"
      ? target.directory
      : target.runId;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const realDirectory = (resolved: string): Effect.Effect<string> =>
    fs.realPath(resolved).pipe(
      Effect.catch(() => {
        const parent = path.dirname(resolved);
        return parent === resolved
          ? Effect.succeed(resolved)
          : realDirectory(parent).pipe(
              Effect.map((real) => path.join(real, path.basename(resolved))),
            );
      }),
    );

  const resolveTarget = (target: UsageClaimTarget): Effect.Effect<UsageClaimTarget> =>
    target.kind === "directory"
      ? realDirectory(path.resolve(target.directory)).pipe(
          Effect.map((directory) => ({ kind: "directory", directory })),
        )
      : Effect.succeed(target);

  const claim = Effect.fn("UsageClaims.claim")(function* (input: {
    readonly target: UsageClaimTarget;
    readonly value: UsageClaimValue | null;
    readonly ifUnclaimed?: boolean;
  }) {
    const target = yield* resolveTarget(input.target);
    const key = targetKey(target);
    const from = claimedFrom(target);
    if (input.value === null) {
      const keys =
        input.target.kind === "directory" ? [key, path.resolve(input.target.directory)] : [key];
      yield* sql`
        DELETE FROM usage_claims
        WHERE target_kind = ${target.kind} AND target IN ${sql.in(keys)} AND claimed_from = ${from}
      `;
      return { target, value: null, kept: false };
    }
    const claimedAt = DateTime.formatIso(yield* DateTime.now);
    const cause = "causedBy" in input.value ? input.value.causedBy : null;
    const device = "device" in input.value ? input.value.device : null;
    const bound =
      "bound" in input.value && input.value.bound !== undefined
        ? encodeBound(input.value.bound)
        : null;
    const onConflict =
      input.ifUnclaimed === true
        ? sql`DO NOTHING`
        : sql`DO UPDATE SET
            cause_thread_id = excluded.cause_thread_id,
            cause_run_id = excluded.cause_run_id,
            cause_message_id = excluded.cause_message_id,
            device = excluded.device,
            bound_json = excluded.bound_json,
            claimed_at = excluded.claimed_at`;
    const written = yield* sql`
      INSERT INTO usage_claims
        (target_kind, target, claimed_from, cause_thread_id, cause_run_id, cause_message_id,
          device, bound_json, claimed_at)
      VALUES (${target.kind}, ${key}, ${from}, ${cause?.threadId ?? null},
        ${cause?.runId ?? null}, ${cause?.messageId ?? null}, ${device}, ${bound}, ${claimedAt})
      ON CONFLICT (target_kind, target, claimed_from) ${onConflict}
      RETURNING target
    `;
    if (written.length > 0) return { target, value: input.value, kept: false };
    const [stored] = yield* sql<StoredValueRow>`
      SELECT cause_thread_id, cause_run_id, cause_message_id, device, bound_json FROM usage_claims
      WHERE target_kind = ${target.kind} AND target = ${key} AND claimed_from = ${from}
    `;
    return { target, value: stored === undefined ? null : storedValue(stored), kept: true };
  });

  const storedClaims = (rows: ReadonlyArray<ClaimRow>) =>
    rows.flatMap((row): StoredUsageClaim[] => {
      const kind = row.target_kind;
      const device = row.device === "phone" || row.device === "computer" ? row.device : null;
      const fromMs = row.claimed_from === NO_START ? undefined : Date.parse(row.claimed_from);
      if (kind !== "session" && kind !== "directory" && kind !== "run") return [];
      if ((row.cause_message_id === null) === (device === null)) return [];
      if (Number.isNaN(fromMs)) return [];
      const bound = device === null ? undefined : decodeBound(row.bound_json);
      const claimed: StoredUsageClaim = {
        kind,
        target: row.target,
        causeMessageId: row.cause_message_id,
        device,
        ...(bound === undefined ? {} : { bound }),
      };
      return [fromMs === undefined ? claimed : { ...claimed, fromMs }];
    });

  const read = sql<ClaimRow>`
    SELECT target_kind, target, claimed_from, cause_message_id, device, bound_json
    FROM usage_claims
  `.pipe(NodeSqliteClient.readOnly, Effect.map(storedClaims), Effect.withSpan("UsageClaims.read"));

  const readRuns = Effect.fn("UsageClaims.readRuns")(function* (runIds: ReadonlyArray<string>) {
    if (runIds.length === 0) return [];
    const rows = yield* sql<ClaimRow>`
      SELECT target_kind, target, claimed_from, cause_message_id, device, bound_json
      FROM usage_claims WHERE target_kind = 'run' AND target IN ${sql.in(runIds)}
    `.pipe(NodeSqliteClient.readOnly);
    return storedClaims(rows);
  });

  return UsageClaims.of({ claim, read, readRuns });
});

export const layer = Layer.effect(UsageClaims, make);
