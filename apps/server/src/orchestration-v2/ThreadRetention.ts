import {
  CommandId,
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const idPart = (value: string) => encodeURIComponent(value);

/** One note per thread and request id, whoever sends it, so a retry or restart never posts twice. */
export const noteIds = (threadId: ThreadId, requestId: string) => ({
  commandId: CommandId.make(`command:thread-note:${idPart(threadId)}:${idPart(requestId)}`),
  messageId: MessageId.make(`message:thread-note:${idPart(threadId)}:${idPart(requestId)}`),
});

export const executionFencedCause = (threadId: ThreadId): string =>
  `Thread ${threadId} is retired from running: its workspace went back to its owner. It stays readable; lift its execution fence to run it again.`;

/**
 * Notes posted since the agent's last prompted turn began, as context ahead of its next prompt.
 * Turns for `deferredMessageIds` (compaction, /goal) carried no context, so they deliver none.
 */
export function pendingNotesContext(input: {
  readonly messages: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "note" | "runId" | "text" | "createdAt">
  >;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "userMessageId">>;
  readonly attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "runId">>;
  readonly providerThreads: ReadonlyArray<
    Pick<OrchestrationV2ProviderThread, "id" | "ownerNodeId">
  >;
  readonly providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "providerThreadId" | "runAttemptId" | "startedAt">
  >;
  readonly deferredMessageIds: ReadonlySet<MessageId>;
}): string {
  const rootThreadIds = new Set(
    input.providerThreads.flatMap((thread) => (thread.ownerNodeId === null ? [thread.id] : [])),
  );
  const runMessageIds = new Map(input.runs.map((run) => [run.id, run.userMessageId]));
  const attemptMessageIds = new Map(
    input.attempts.map((attempt) => [attempt.id, runMessageIds.get(attempt.runId)]),
  );
  const lastTurnStartedAt = input.providerTurns.reduce<DateTime.Utc | null>((latest, turn) => {
    const messageId =
      turn.runAttemptId === null ? undefined : attemptMessageIds.get(turn.runAttemptId);
    return turn.startedAt !== null &&
      rootThreadIds.has(turn.providerThreadId) &&
      messageId !== undefined &&
      !input.deferredMessageIds.has(messageId) &&
      (latest === null || DateTime.isGreaterThan(turn.startedAt, latest))
      ? turn.startedAt
      : latest;
  }, null);
  const notes = input.messages.filter(
    (message) =>
      message.note === true &&
      message.runId === null &&
      (lastTurnStartedAt === null || DateTime.isGreaterThan(message.createdAt, lastTurnStartedAt)),
  );
  if (notes.length === 0) return "";
  return [
    "Notes posted to this thread since your last turn. The user saw them here:",
    ...notes.map((note) => note.text),
  ].join("\n\n---\n\n");
}
