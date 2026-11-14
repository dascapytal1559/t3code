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

/** A provider session, by its native id, or every session whose working folder is inside a folder. */
export type UsageClaimTarget =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "directory"; readonly directory: string };

export interface StoredUsageClaim {
  readonly kind: UsageClaimTarget["kind"];
  /** The session id, or the resolved folder. */
  readonly target: string;
  readonly causeMessageId: string;
}

/**
 * Sessions an agent ran outside T3 (a pipeline, a child CLI run), claimed for the prompt that
 * caused them, so Usage counts them there. Claiming again replaces the cause; a null cause removes
 * the claim. Folders are stored resolved, as transcripts record them.
 */
export class UsageClaims extends Context.Service<
  UsageClaims,
  {
    readonly claim: (input: {
      readonly target: UsageClaimTarget;
      readonly causedBy: OrchestrationV2CausedBy | null;
    }) => Effect.Effect<
      { readonly target: UsageClaimTarget; readonly causedBy: OrchestrationV2CausedBy | null },
      SqlError.SqlError
    >;
    readonly read: Effect.Effect<ReadonlyArray<StoredUsageClaim>, SqlError.SqlError>;
  }
>()("t3/usage/UsageClaims") {}

interface ClaimRow {
  readonly target_kind: string;
  readonly target: string;
  readonly cause_message_id: string;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const resolveTarget = (target: UsageClaimTarget): Effect.Effect<UsageClaimTarget> => {
    if (target.kind === "session") return Effect.succeed(target);
    const resolved = path.resolve(target.directory);
    return fs.realPath(resolved).pipe(
      Effect.orElseSucceed(() => resolved),
      Effect.map((directory) => ({ kind: "directory", directory })),
    );
  };

  const claim = Effect.fn("UsageClaims.claim")(function* (input: {
    readonly target: UsageClaimTarget;
    readonly causedBy: OrchestrationV2CausedBy | null;
  }) {
    const target = yield* resolveTarget(input.target);
    const key = target.kind === "session" ? target.sessionId : target.directory;
    if (input.causedBy === null) {
      yield* sql`DELETE FROM usage_claims WHERE target_kind = ${target.kind} AND target = ${key}`;
      return { target, causedBy: null };
    }
    const claimedAt = DateTime.formatIso(yield* DateTime.now);
    const { threadId, runId, messageId } = input.causedBy;
    yield* sql`
      INSERT INTO usage_claims
        (target_kind, target, cause_thread_id, cause_run_id, cause_message_id, claimed_at)
      VALUES (${target.kind}, ${key}, ${threadId}, ${runId ?? null}, ${messageId}, ${claimedAt})
      ON CONFLICT (target_kind, target) DO UPDATE SET
        cause_thread_id = excluded.cause_thread_id,
        cause_run_id = excluded.cause_run_id,
        cause_message_id = excluded.cause_message_id,
        claimed_at = excluded.claimed_at
    `;
    return { target, causedBy: input.causedBy };
  });

  const read = sql<ClaimRow>`
    SELECT target_kind, target, cause_message_id FROM usage_claims
  `.pipe(
    NodeSqliteClient.readOnly,
    Effect.map((rows) =>
      rows.flatMap((row): StoredUsageClaim[] =>
        row.target_kind === "session" || row.target_kind === "directory"
          ? [{ kind: row.target_kind, target: row.target, causeMessageId: row.cause_message_id }]
          : [],
      ),
    ),
    Effect.withSpan("UsageClaims.read"),
  );

  return UsageClaims.of({ claim, read });
});

export const layer = Layer.effect(UsageClaims, make);
