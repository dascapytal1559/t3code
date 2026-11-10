import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  CommandId,
  MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ServerSettingsService from "../serverSettings.ts";
import { neverStarted } from "./RestartBackgroundNote.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const MAX_NOTE_CREW = 10;

/** Started and ended cancelled without a Stop: the restart cut it, as continueRestartedRun assumes. */
function cutByRestart(thread: OrchestrationV2ThreadShell): boolean {
  return (
    thread.status === "cancelled" &&
    thread.latestRunStartedAt != null &&
    thread.latestRunStopRequested !== true
  );
}

interface Roster {
  readonly settings: ServerSettings;
  readonly nowMs: number;
  readonly startedAt: string;
  readonly live: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly crewOf: ReadonlyMap<ThreadId | undefined, ReadonlyArray<OrchestrationV2ThreadShell>>;
  readonly pinnedProjects: ReadonlySet<ProjectId>;
}

const loadRoster = Effect.gen(function* () {
  const settings = yield* (yield* ServerSettingsService.ServerSettingsService).getSettings.pipe(
    Effect.orElseSucceed(() => null),
  );
  if (!settings) return undefined;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const live = (yield* threads.getShellSnapshot()).threads.filter(
    (thread) => thread.archivedAt === null && thread.deletedAt === null,
  );
  return {
    settings,
    nowMs: DateTime.toEpochMillis(yield* DateTime.now),
    startedAt: DateTime.formatIso(yield* threads.serverStartedAt),
    live,
    crewOf: Map.groupBy(
      live.filter((thread) => thread.crewOf !== undefined),
      (thread) => thread.crewOf,
    ),
    pinnedProjects: new Set(
      live.filter((thread) => thread.coordinator === true).map((thread) => thread.projectId),
    ),
  } satisfies Roster;
});

/**
 * The note a coordinator is owed for this server start, or undefined. A pinned one is owed one
 * even when busy or crewless. Beside a pin, an unpinned one needs a cut crew run, so stale
 * sessions stay asleep.
 */
function owedNote(roster: Roster, coordinator: OrchestrationV2ThreadShell): string | undefined {
  const crew = roster.crewOf.get(coordinator.id) ?? [];
  const cutCrew = crew.filter(cutByRestart);
  if (
    (coordinator.coordinator !== true &&
      ((roster.pinnedProjects.has(coordinator.projectId) ? cutCrew : crew).length === 0 ||
        coordinator.activeRunId !== null ||
        coordinator.status === "queued")) ||
    coordinator.settledOverride === "settled" ||
    (coordinator.snoozedUntil != null &&
      DateTime.toEpochMillis(coordinator.snoozedUntil) > roster.nowMs) ||
    !resolveProjectSettings(roster.settings, coordinator.projectId).settings
      .continueThreadsAfterServerUpdate
  )
    return undefined;
  const omitted = cutCrew.length - MAX_NOTE_CREW;
  return [
    `The T3 server restarted at ${roster.startedAt}.`,
    ...(cutCrew.length === 0
      ? ["None of your crew threads had a run interrupted."]
      : [
          "These crew threads had runs interrupted:",
          ...cutCrew
            .slice(0, MAX_NOTE_CREW)
            .map((thread) => `- ${thread.title.replaceAll(/\s+/g, " ").trim()} (${thread.id})`),
          ...(omitted > 0 ? [`- and ${omitted} more`] : []),
        ]),
    "That ended your session, and whatever lived only in it, such as background commands, waits and monitors, is gone. Run your session-start steps again, check what is still running, and report.",
  ].join("\n");
}

const logNoteFailure = <A, E, R>(effect: Effect.Effect<A, E, R>, threadId: ThreadId) =>
  effect.pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) =>
        Effect.logWarning("Failed to tell a coordinator the server restarted", { threadId, cause }),
    ),
  );

const sendNote = Effect.fn("CoordinatorRestartNote.sendNote")(
  function* (roster: Roster, coordinatorId: ThreadId, text: string) {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const messageId = MessageId.make(`message:restart-note:${coordinatorId}:${roster.startedAt}`);
    const { messages } = yield* threads.getThreadRecords(coordinatorId, ["messages"], {
      messageIds: [messageId],
    });
    if (messages.some((message) => message.id === messageId)) return;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`command:restart-note:${coordinatorId}:${roster.startedAt}`),
      threadId: coordinatorId,
      messageId,
      text,
      notification: {
        source: { kind: "system" },
        outcome: "updated",
        summary: "T3 Code restarted and told this thread about its crew",
        detail: text,
      },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
  },
  (effect, _roster, threadId) => logNoteFailure(effect, threadId),
);

/** Whether T3 is about to resume this thread's last run, the one restartContinuationRun picks. */
const resumePending = Effect.fn("CoordinatorRestartNote.resumePending")(function* (
  threadId: ThreadId,
) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
  const source = runs.reduce<OrchestrationV2Run | undefined>(
    (latest, run) =>
      run.status !== "queued" && !neverStarted(run) && (!latest || runRanAfter(run, latest))
        ? run
        : latest,
    undefined,
  );
  return source !== undefined && (yield* threads.restartContinuationPending(source));
});

/**
 * A restart ends a coordinator's session and nothing inside it can wake it, so server start
 * sends each one it owes a note. A note that started first would make the orchestrator drop a
 * pending restart continuation, so one T3 resumes waits for that turn, which carries the note
 * for a pinned coordinator.
 */
export const notifyCoordinators = Effect.fn("CoordinatorRestartNote.notifyCoordinators")(
  function* () {
    const roster = yield* loadRoster;
    if (!roster) return;
    for (const coordinator of roster.live) {
      const text = owedNote(roster, coordinator);
      if (text === undefined) continue;
      const resuming = yield* resumePending(coordinator.id).pipe(Effect.orElseSucceed(() => false));
      if (!resuming) yield* sendNote(roster, coordinator.id, text);
    }
  },
  // A missed note must not hold up startup.
  Effect.catchCauseIf(
    (cause) => !Cause.hasInterruptsOnly(cause),
    (cause) => Effect.logWarning("Failed to tell coordinators the server restarted", { cause }),
  ),
);

const pinnedNote = Effect.fn("CoordinatorRestartNote.pinnedNote")(function* (threadId: ThreadId) {
  const roster = yield* loadRoster;
  const coordinator = roster?.live.find((thread) => thread.id === threadId);
  return roster === undefined || coordinator?.coordinator !== true
    ? undefined
    : { roster, text: owedNote(roster, coordinator) };
});

/** The note that opens a pinned coordinator's resumed turn, or undefined for any other thread. */
export const resumedCoordinatorNote = Effect.fn("CoordinatorRestartNote.resumedCoordinatorNote")(
  function* (thread: { readonly id: ThreadId; readonly coordinator?: boolean | undefined }) {
    if (thread.coordinator !== true) return undefined;
    return (yield* pinnedNote(thread.id))?.text;
  },
);

/** A pinned coordinator whose restart continuation declined still gets its note. */
export const notifyCoordinatorUnlessResumed = Effect.fn(
  "CoordinatorRestartNote.notifyCoordinatorUnlessResumed",
)(
  function* (threadId: ThreadId, resumeMessageId: MessageId) {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const { thread, messages } = yield* threads.getThreadRecords(threadId, ["messages"], {
      messageIds: [resumeMessageId],
    });
    if (thread.coordinator !== true || messages.some((message) => message.id === resumeMessageId))
      return;
    const note = yield* pinnedNote(threadId);
    if (note?.text !== undefined) yield* sendNote(note.roster, threadId, note.text);
  },
  (effect, threadId) => logNoteFailure(effect, threadId),
);
