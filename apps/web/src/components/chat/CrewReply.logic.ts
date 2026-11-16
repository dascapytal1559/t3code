import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { isIndefiniteSnooze, type MessageId, type ThreadId } from "@t3tools/contracts";

/**
 * The message a reply from a worker's thread puts in its coordinator's chat: a header naming the
 * worker, the line FirstMate reads the worker from (`bin/fm-t3-worker-reply.sh`), then the words.
 */
export function formatCrewReply(input: {
  readonly thread: { readonly id: ThreadId; readonly title: string };
  readonly text: string;
}): string {
  return [
    `**Reply · ${input.thread.title}**`,
    `kept-thread: ${input.thread.id}`,
    "",
    input.text.trim(),
  ].join("\n");
}

/** What the captain did to a crew thread that FirstMate keeps a record of. */
export type CrewThreadAction =
  | { readonly kind: "settled" | "unsettled" | "unsnoozed" }
  | { readonly kind: "snoozed"; readonly snoozedUntil: string };

const CREW_THREAD_ACTION_HEADINGS = {
  settled: "Settled",
  unsettled: "Un-settled",
  snoozed: "Snoozed",
  unsnoozed: "Un-snoozed",
} as const;

/**
 * The note a captain's settle, snooze or their undoing puts in the worker's coordinator chat, so
 * FirstMate's records follow. Laid out like a reply, with the action on its own line.
 */
export function formatCrewThreadAction(input: {
  readonly thread: { readonly id: ThreadId; readonly title: string };
  readonly action: CrewThreadAction;
}): string {
  const { action } = input;
  const detail =
    action.kind !== "snoozed"
      ? action.kind
      : isIndefiniteSnooze(action.snoozedUntil)
        ? "snoozed"
        : `snoozed until ${new Date(action.snoozedUntil).toISOString().replace(/\.\d{3}Z$/, "Z")}`;
  return [
    `**${CREW_THREAD_ACTION_HEADINGS[action.kind]} · ${input.thread.title}**`,
    `kept-thread: ${input.thread.id}`,
    `thread-action: ${detail}`,
  ].join("\n");
}

/**
 * One user message to a coordinator, behind its running turn or at once when it is idle, the way
 * the composer's Queue sends.
 */
export function coordinatorMessageInput(input: {
  readonly coordinator: Pick<EnvironmentThreadShell, "id" | "runtimeMode" | "interactionMode">;
  readonly messageId: MessageId;
  readonly text: string;
}) {
  return {
    threadId: input.coordinator.id,
    message: {
      messageId: input.messageId,
      role: "user" as const,
      text: input.text,
      attachments: [],
    },
    runtimeMode: input.coordinator.runtimeMode,
    interactionMode: input.coordinator.interactionMode,
    dispatchMode: "queue" as const,
  };
}
