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
import {
  isImportedAgentSessionMessageId,
  MessageId,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { compareDateTimeStrings } from "@t3tools/shared/dateTime";

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

/** Preserve imported history's revert boundary while giving its copy a unique id. */
export function forkedMessageId(forkThreadId: ThreadId, sourceId: string): MessageId {
  const id = forkedEntityId(forkThreadId, sourceId);
  return MessageId.make(isImportedAgentSessionMessageId(sourceId) ? `import:${id}` : id);
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

/**
 * The instant a fork's copied history ends: the request time of the first
 * source turn after the fork turn (pending rows included), or null when the
 * fork turn is the source's last. Turns run one at a time, a steered prompt
 * lands before the next turn is requested, and queued follow-ups are held by
 * the client until sent, so every row the fork keeps was created before this
 * instant. It replaces prompt-per-turn counting, which breaks once background
 * work opens prompt-less turns or steering puts several prompts in one turn.
 * `turns` may be in any order. Null as well when the fork turn is unknown.
 */
export function resolveForkCutoffAt(
  turns: ReadonlyArray<{ readonly turnId: TurnId | null; readonly requestedAt: string }>,
  forkTurnId: TurnId,
): string | null {
  const forkTurn = turns.find((turn) => turn.turnId === forkTurnId);
  if (forkTurn === undefined) return null;
  let cutoffAt: string | null = null;
  for (const turn of turns) {
    if (turn === forkTurn || compareDateTimeStrings(turn.requestedAt, forkTurn.requestedAt) <= 0) {
      continue;
    }
    if (cutoffAt === null || compareDateTimeStrings(turn.requestedAt, cutoffAt) < 0) {
      cutoffAt = turn.requestedAt;
    }
  }
  return cutoffAt;
}

/** Whether a source row created at `createdAt` belongs to a fork cut at `cutoffAt`. */
export function forkKeepsRow(cutoffAt: string | null, createdAt: string): boolean {
  return cutoffAt === null || compareDateTimeStrings(createdAt, cutoffAt) < 0;
}
