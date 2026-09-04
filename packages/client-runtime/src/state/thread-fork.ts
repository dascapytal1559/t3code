/**
 * Thread fork rules shared by web and mobile (FORK_FEATURES.md: Fork a
 * thread). The server owns the copy; clients only decide when to offer the
 * action and how to name the result.
 */
import type { OrchestrationLatestTurn, OrchestrationSession, TurnId } from "@t3tools/contracts";

/**
 * Drivers whose adapters fork conversations natively. Mirrors each adapter's
 * `conversationFork` capability; the server rejects anything else, and the
 * clients hide the action rather than offer a fork that would fail.
 */
const THREAD_FORK_DRIVER_KINDS: ReadonlySet<string> = new Set(["codex", "claudeAgent", "opencode"]);

export function providerSupportsThreadFork(providerName: string | null | undefined): boolean {
  return providerName != null && THREAD_FORK_DRIVER_KINDS.has(providerName);
}

/**
 * The turn a whole-thread fork copies through: the latest turn, once it has
 * settled. Null while the thread is still working or has no turn yet.
 */
export function resolveThreadForkTurnId(thread: {
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly session: OrchestrationSession | null;
}): TurnId | null {
  const latestTurn = thread.latestTurn;
  if (latestTurn === null || latestTurn.state === "running") {
    return null;
  }
  if (thread.session?.status === "running" && thread.session.activeTurnId != null) {
    return null;
  }
  return latestTurn.turnId;
}

const FORK_TITLE_SUFFIX = " (fork)";
const FORK_TITLE_MAX_LENGTH = 120;

/** The fork's title: the source title plus a suffix, trimmed to fit. */
export function forkedThreadTitle(sourceTitle: string): string {
  const trimmed = sourceTitle.trim();
  const base =
    trimmed.length + FORK_TITLE_SUFFIX.length > FORK_TITLE_MAX_LENGTH
      ? `${trimmed.slice(0, FORK_TITLE_MAX_LENGTH - FORK_TITLE_SUFFIX.length - 1).trimEnd()}…`
      : trimmed;
  return `${base}${FORK_TITLE_SUFFIX}`;
}
