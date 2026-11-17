import { CommandId, isPrimaryCoordinator, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import { coldAtMs, coldClearRule, coldClearWaits, isSessionRotationMessage } from "./ColdClear.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const ENDED_RUN_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled"]);

/**
 * Fork: the clock that rotates FirstMate's main session. When the cold rule turns true on an idle
 * thread, it sends `thread.session.rotate`, whose note starts a fresh session there and then,
 * instead of at the next input, which FirstMate's own wakes would reach first. Timers are
 * re-derived from records at start and after every run, so a restart loses none.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const rotateWhenCold = Effect.fn("SessionRotationService.rotateWhenCold")(
    function* (threadId: ThreadId) {
      while (true) {
        const thread = yield* projections.getThread(threadId);
        const rule = coldClearRule(thread, undefined);
        if (
          !isPrimaryCoordinator(thread) ||
          rule === undefined ||
          thread.archivedAt !== null ||
          thread.deletedAt !== null
        )
          return;
        const activeProviderThreadIds =
          thread.activeProviderThreadId === null ? [] : [thread.activeProviderThreadId];
        const records = yield* projections.getThreadRecords(
          threadId,
          ["runs", "providerThreads", "providerTurns", "runtimeRequests", "contextTransfers"],
          {
            runStatuses: ["queued", "preparing", "starting", "running", "waiting"],
            includeLatestRun: true,
            providerThreadIds: activeProviderThreadIds,
            providerTurnThreadIds: activeProviderThreadIds,
            latestProviderTurnUsageOnly: true,
            runtimeRequestStatuses: ["pending"],
            contextTransferStatuses: ["pending"],
          },
        );
        // Whatever holds the thread re-arms the clock when its run ends.
        if (records.runs.some((run) => run.status === "queued") || coldClearWaits(records)) return;
        const latestRun = records.runs.reduce<(typeof records.runs)[number] | undefined>(
          (latest, run) => (latest === undefined || run.ordinal > latest.ordinal ? run : latest),
          undefined,
        );
        const providerThread = records.providerThreads.find(
          (candidate) => candidate.id === records.thread.activeProviderThreadId,
        );
        const coldAt = coldAtMs(records, providerThread, rule);
        // Past a rotation's own note the clock waits for real work: one rotation per idle spell.
        if (
          latestRun === undefined ||
          isSessionRotationMessage(latestRun.userMessageId) ||
          coldAt === undefined
        )
          return;
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        if (nowMs < coldAt) {
          yield* Effect.sleep(Duration.millis(coldAt - nowMs));
          continue;
        }
        yield* orchestrator.dispatch({
          type: "thread.session.rotate",
          // One rotation per idle spell, even across restarts and duplicate events.
          commandId: CommandId.make(`server:session-rotation:${threadId}:${latestRun.id}`),
          threadId,
          reason: "cache_expired",
        });
        return;
      }
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Effect.logWarning("session rotation skipped", { threadId, cause }),
        ),
      ),
  );

  const start = Effect.fn("SessionRotationService.start")(function* () {
    // Keyed by thread: a run that ends replaces the waiting timer.
    const timers = yield* FiberMap.make<ThreadId>();
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "run.updated" && ENDED_RUN_STATUSES.has(event.payload.status)
          ? FiberMap.run(timers, event.threadId, rotateWhenCold(event.threadId))
          : Effect.void,
      ),
    );
    // A session that went idle before this start has no run left to end.
    yield* forkParked(
      projections.getShellSnapshot().pipe(
        Effect.flatMap(({ threads }) =>
          Effect.forEach(
            threads.filter(
              (thread) =>
                isPrimaryCoordinator(thread) &&
                thread.archivedAt === null &&
                thread.deletedAt === null,
            ),
            (thread) => FiberMap.run(timers, thread.id, rotateWhenCold(thread.id)),
            { discard: true },
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("session rotation could not read threads at start", { cause }),
        ),
      ),
    );
  });
  return { start };
});
