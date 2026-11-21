import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { MessageId, OrchestrationV2CrewNote, ThreadId } from "@t3tools/contracts";

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

/**
 * One user message to a coordinator, behind its running turn or at once when it is idle, the way
 * the composer's Queue sends. It names the crew thread it is about, so Usage moves that thread's
 * work to this device for a typed reply, and leaves it where it was for a click (`action`).
 */
export function coordinatorMessageInput(input: {
  readonly coordinator: Pick<EnvironmentThreadShell, "id" | "runtimeMode" | "interactionMode">;
  readonly messageId: MessageId;
  readonly text: string;
  readonly crewNote: OrchestrationV2CrewNote;
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
    crewNote: input.crewNote,
  };
}
