/**
 * Thread fork helpers shared by the in-memory projector, the SQL projection
 * pipeline, and the fork dispatch path (FORK_FEATURES.md: Fork a thread).
 *
 * A fork is a `thread.created` event with `forkedFrom`: projectors copy the
 * source thread's rows through the named turn (inclusive) under the new
 * thread id. Everything here is pure so the copy is deterministic across
 * projectors and across event-log replays.
 */
import * as NodeCrypto from "node:crypto";
import type { ThreadId, TurnId } from "@t3tools/contracts";

/**
 * Deterministic id for a row copied into a fork. Message and activity ids are
 * global primary keys in the projections, so copies need fresh ids; deriving
 * them from (fork thread id, source id) lets every projector and every replay
 * agree without carrying an id map in the event. Formatted like a UUID so ids
 * stay uniform with client-minted ones.
 */
export function forkedEntityId(forkThreadId: ThreadId, sourceId: string): string {
  const hex = NodeCrypto.createHash("sha256").update(`${forkThreadId} ${sourceId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface ForkCutoff {
  /** Turn ids copied into the fork, in source order, ending at the fork turn. */
  readonly retainedTurnIds: ReadonlySet<string>;
  /**
   * Turn count at the fork point: the fork turn's checkpoint turn count when
   * it has one, else its 1-based position. Feeds the same message-retention
   * fallback revert uses for prompts that never got a turn id.
   */
  readonly turnCount: number;
}

/**
 * Resolve which turns a fork keeps. `orderedTurns` must be the source thread's
 * turns in timeline order. Returns null when the fork turn is not among them.
 */
export function resolveForkCutoff(
  orderedTurns: ReadonlyArray<{
    readonly turnId: TurnId | null;
    readonly checkpointTurnCount: number | null;
  }>,
  forkTurnId: TurnId,
): ForkCutoff | null {
  const retainedTurnIds = new Set<string>();
  let position = 0;
  for (const turn of orderedTurns) {
    if (turn.turnId === null) continue;
    position += 1;
    retainedTurnIds.add(turn.turnId);
    if (turn.turnId === forkTurnId) {
      return { retainedTurnIds, turnCount: turn.checkpointTurnCount ?? position };
    }
  }
  return null;
}
