import type { OrchestrationV2CausedBy } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
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

/** What a claim counts its target to: the prompt that caused it, or a device directly. */
export type UsageClaimValue =
  | { readonly causedBy: OrchestrationV2CausedBy }
  | { readonly device: UsageClaimDevice };

export interface StoredUsageClaim {
  readonly kind: UsageClaimTarget["kind"];
  /** The session id, the resolved folder, or the run id. */
  readonly target: string;
  /** A session claim's start, in epoch ms; absent, it covers the whole session. */
  readonly fromMs?: number;
  readonly causeMessageId: string | null;
  readonly device: UsageClaimDevice | null;
}

/**
 * Work Usage can't trace on its own, claimed by an agent: sessions run outside T3 (a pipeline, a
 * child CLI run), or a turn whose prompt has no cause (a wake, upkeep, a voice journal). A session
 * keeps one claim per start time. Claiming the same target again replaces the value; a null value
 * removes the claim. Folders are stored resolved, as transcripts record them.
 */
export class UsageClaims extends Context.Service<
  UsageClaims,
  {
    readonly claim: (input: {
      readonly target: UsageClaimTarget;
      readonly value: UsageClaimValue | null;
    }) => Effect.Effect<
      { readonly target: UsageClaimTarget; readonly value: UsageClaimValue | null },
      SqlError.SqlError
    >;
    readonly read: Effect.Effect<ReadonlyArray<StoredUsageClaim>, SqlError.SqlError>;
  }
>()("t3/usage/UsageClaims") {}

interface ClaimRow {
  readonly target_kind: string;
  readonly target: string;
  readonly claimed_from: string;
  readonly cause_message_id: string | null;
  readonly device: string | null;
}

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
      return { target, value: null };
    }
    const claimedAt = DateTime.formatIso(yield* DateTime.now);
    const cause = "causedBy" in input.value ? input.value.causedBy : null;
    const device = "device" in input.value ? input.value.device : null;
    yield* sql`
      INSERT INTO usage_claims
        (target_kind, target, claimed_from, cause_thread_id, cause_run_id, cause_message_id,
          device, claimed_at)
      VALUES (${target.kind}, ${key}, ${from}, ${cause?.threadId ?? null},
        ${cause?.runId ?? null}, ${cause?.messageId ?? null}, ${device}, ${claimedAt})
      ON CONFLICT (target_kind, target, claimed_from) DO UPDATE SET
        cause_thread_id = excluded.cause_thread_id,
        cause_run_id = excluded.cause_run_id,
        cause_message_id = excluded.cause_message_id,
        device = excluded.device,
        claimed_at = excluded.claimed_at
    `;
    return { target, value: input.value };
  });

  const read = sql<ClaimRow>`
    SELECT target_kind, target, claimed_from, cause_message_id, device FROM usage_claims
  `.pipe(
    NodeSqliteClient.readOnly,
    Effect.map((rows) =>
      rows.flatMap((row): StoredUsageClaim[] => {
        const kind = row.target_kind;
        const device = row.device === "phone" || row.device === "computer" ? row.device : null;
        const fromMs = row.claimed_from === NO_START ? undefined : Date.parse(row.claimed_from);
        if (kind !== "session" && kind !== "directory" && kind !== "run") return [];
        if ((row.cause_message_id === null) === (device === null)) return [];
        if (Number.isNaN(fromMs)) return [];
        const claimed: StoredUsageClaim = {
          kind,
          target: row.target,
          causeMessageId: row.cause_message_id,
          device,
        };
        return [fromMs === undefined ? claimed : { ...claimed, fromMs }];
      }),
    ),
    Effect.withSpan("UsageClaims.read"),
  );

  return UsageClaims.of({ claim, read });
});

export const layer = Layer.effect(UsageClaims, make);
