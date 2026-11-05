import { CommandId, type OrchestrationV2Run, type RunId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import {
  SESSION_REFRESH_OPENING_TEXT,
  isSessionRefreshStowMessageId,
  sessionRefreshOpeningMessageId,
} from "./SessionRefresh.ts";

const isTerminalRunStatus = (status: OrchestrationV2Run["status"]) =>
  status === "completed" ||
  status === "failed" ||
  status === "interrupted" ||
  status === "cancelled";

/**
 * Finishes a context refresh once its `/stow` turn ends: releases the old agent session and
 * waits for its process to exit, drops it from the thread, then opens the fresh session with
 * `Context refreshed.`. A `/stow` turn that did not complete keeps the session and says so in the thread.
 * Nothing is remembered across a server restart; a refresh cut by one is simply not finished.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

  const complete = Effect.fn("SessionRefreshService.complete")(
    function* (threadId: ThreadId, stowRun: OrchestrationV2Run) {
      const commandId = (step: string) =>
        CommandId.make(`server:session-refresh:${stowRun.id}:${step}`);
      const finish = (outcome: "replaced" | "kept", detail?: string) =>
        orchestrator.dispatch({
          type: "thread.session.refresh.complete",
          commandId: commandId(outcome),
          threadId,
          providerThreadId: stowRun.providerThreadId,
          runId: stowRun.id,
          outcome,
          ...(detail === undefined ? {} : { detail }),
        });
      if (stowRun.status !== "completed") {
        yield* finish(
          "kept",
          stowRun.status === "failed"
            ? "the /stow turn failed."
            : `the /stow turn was ${stowRun.status}.`,
        );
        return;
      }
      const { providerThreads } = yield* orchestrator.getThreadProjection(threadId);
      const providerSessionId =
        providerThreads.find((candidate) => candidate.id === stowRun.providerThreadId)
          ?.providerSessionId ?? null;
      // The next session must find the old process gone: FirstMate's session lock belongs to
      // the live process, and a session that loses it comes up read-only.
      if (providerSessionId !== null && (yield* sessions.isLive(providerSessionId))) {
        const released = yield* sessions.releaseUnlessBusy({
          providerSessionId,
          ownProviderThreadIds: stowRun.providerThreadId === null ? [] : [stowRun.providerThreadId],
          reason: "manual_shutdown",
          detail: "Context refresh",
        });
        if (!released) {
          yield* finish("kept", "the agent was still busy.");
          return;
        }
      }
      const replaced = yield* finish("replaced").pipe(
        Effect.as(true),
        Effect.catchIf(Orchestrator.isOrchestratorDispatchError, (error) =>
          finish("kept", `${error.cause}`).pipe(Effect.as(false)),
        ),
      );
      if (!replaced) return;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: commandId("opening"),
        messageId: sessionRefreshOpeningMessageId(stowRun.id),
        threadId,
        text: SESSION_REFRESH_OPENING_TEXT,
        attachments: [],
        createdBy: "agent",
        creationSource: "server",
        dispatchMode: { type: "start_immediately" },
      });
    },
    (effect, threadId, stowRun) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("context refresh did not finish", {
            threadId,
            runId: stowRun.id,
            cause,
          }),
        ),
      ),
  );

  const start = Effect.fn("SessionRefreshService.start")(function* () {
    const completions = yield* FiberSet.make();
    // A finished run reports more than once (its checkpoint, for one); each refresh ends once.
    const seen = new Set<RunId>();
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
        if (
          event.type !== "run.updated" ||
          !isTerminalRunStatus(event.payload.status) ||
          !isSessionRefreshStowMessageId(event.payload.userMessageId) ||
          seen.has(event.payload.id)
        )
          return Effect.void;
        seen.add(event.payload.id);
        return FiberSet.run(completions, complete(event.threadId, event.payload));
      }),
    );
  });
  return { start };
});
