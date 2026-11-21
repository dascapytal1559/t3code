import {
  CommandId,
  isIndefiniteSnooze,
  MessageId,
  type OrchestrationClientOrigin,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ThreadManagement from "./ThreadManagementService.ts";

/** Fork: a captain's settle or snooze of a crew thread, or the undoing of either. */
type CrewThreadAction =
  | { readonly kind: "settled" | "unsettled" | "unsnoozed" }
  | { readonly kind: "snoozed"; readonly snoozedUntil: string };

type CrewActionCommand = Extract<
  OrchestrationV2Command,
  {
    readonly type: "thread.settle" | "thread.unsettle" | "thread.snooze" | "thread.unsnooze";
  }
>;
type PinCommand = Extract<OrchestrationV2Command, { readonly type: "thread.pin" }>;

export const isCrewActionCommand = (
  command: OrchestrationV2Command,
): command is CrewActionCommand | PinCommand =>
  command.type === "thread.settle" ||
  command.type === "thread.unsettle" ||
  command.type === "thread.snooze" ||
  command.type === "thread.unsnooze" ||
  command.type === "thread.pin";

/** What the command did to the thread as it was, for FirstMate; pinning promotes a settled or snoozed one. */
function crewThreadActionOf(
  command: CrewActionCommand | PinCommand,
  before: Pick<OrchestrationV2ThreadShell, "settledOverride" | "snoozedUntil">,
  nowMs: number,
): CrewThreadAction | null {
  switch (command.type) {
    case "thread.settle":
      return { kind: "settled" };
    case "thread.unsettle":
      return { kind: "unsettled" };
    case "thread.snooze":
      return { kind: "snoozed", snoozedUntil: command.snoozedUntil };
    case "thread.unsnooze":
      return { kind: "unsnoozed" };
    case "thread.pin":
      if (before.settledOverride === "settled") return { kind: "unsettled" };
      return before.snoozedUntil != null && DateTime.toEpochMillis(before.snoozedUntil) > nowMs
        ? { kind: "unsnoozed" }
        : null;
  }
}

const CREW_THREAD_ACTION_HEADINGS = {
  settled: "Settled",
  unsettled: "Un-settled",
  snoozed: "Snoozed",
  unsnoozed: "Un-snoozed",
} as const;

/**
 * The note a captain's settle, snooze or their undoing puts in the worker's coordinator chat, so
 * FirstMate's records follow. Laid out like a crew reply, with the action on its own line.
 */
function formatCrewThreadAction(input: {
  readonly thread: { readonly id: ThreadId; readonly title: string };
  readonly action: CrewThreadAction;
}): string {
  const { action } = input;
  const detail =
    action.kind !== "snoozed"
      ? action.kind
      : isIndefiniteSnooze(action.snoozedUntil)
        ? "snoozed"
        : `snoozed until ${DateTime.formatIso(DateTime.makeUnsafe(action.snoozedUntil)).replace(/\.\d{3}Z$/, "Z")}`;
  return [
    `**${CREW_THREAD_ACTION_HEADINGS[action.kind]} · ${input.thread.title}**`,
    `kept-thread: ${input.thread.id}`,
    `thread-action: ${detail}`,
  ].join("\n");
}

/**
 * Fork: dispatches a client's settle, snooze, pin or undo, then tells the crew thread's coordinator
 * in one queued note, as the crew reply box sends. Only client commands come here, so FirstMate's
 * own MCP changes and the server's automatic ones never echo back to it; a wake of a snooze that
 * limit recovery owns goes through its metadata, so it sends nothing, as its snooze did not.
 */
export const dispatchWithCrewActionNote = Effect.fn("CrewActionNote.dispatch")(function* (
  command: CrewActionCommand | PinCommand,
  origin: OrchestrationClientOrigin | undefined,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const before = yield* threads.getThreadShell(command.threadId);
  const result = yield* threads.dispatch(command);
  if (result.replayed === true || before?.crewOf === undefined || before.archivedAt !== null) {
    return result;
  }
  const action = crewThreadActionOf(command, before, DateTime.toEpochMillis(yield* DateTime.now));
  if (action === null) return result;
  const coordinator = yield* threads.getThreadShell(before.crewOf);
  if (coordinator === null || coordinator.archivedAt !== null) return result;
  // The action already committed, so a note that fails only goes unsent.
  yield* threads
    .dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`command:crew-action:${command.commandId}`),
      threadId: coordinator.id,
      messageId: MessageId.make(`message:crew-action:${command.commandId}`),
      text: formatCrewThreadAction({ thread: before, action }),
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: origin?.surface === "mobile" ? "mobile" : "web",
      ...(origin === undefined ? {} : { origin }),
      crewNote: { threadId: before.id, kind: "action" },
    })
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not tell the coordinator of a crew thread action", {
          threadId: command.threadId,
          cause,
        }),
      ),
    );
  return result;
});
