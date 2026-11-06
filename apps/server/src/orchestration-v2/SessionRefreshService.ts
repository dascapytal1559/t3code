import { CommandId, type OrchestrationV2Run, type RunId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { isSessionRefreshStowMessageId } from "./SessionRefresh.ts";

const isTerminalRunStatus = (status: OrchestrationV2Run["status"]) =>
  status === "completed" ||
  status === "failed" ||
  status === "interrupted" ||
  status === "cancelled";

/**
 * Finishes a context refresh once its `/stow` turn ends: a completed one opens a fresh session
 * with `Context refreshed.`; any other end, or a refusal to swap, keeps the session and says so.
 * Nothing is remembered across a server restart; a refresh cut by one is simply not finished.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;

  const complete = Effect.fn("SessionRefreshService.complete")(
    function* (threadId: ThreadId, stowRun: OrchestrationV2Run) {
      const finish = (outcome: "replaced" | "kept", detail?: string) =>
        orchestrator.dispatch({
          type: "thread.session.refresh.complete",
          commandId: CommandId.make(`server:session-refresh:${stowRun.id}:${outcome}`),
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
      yield* finish("replaced").pipe(
        Effect.catchIf(Orchestrator.isOrchestratorDispatchError, (error) =>
          finish("kept", `${error.cause}`),
        ),
      );
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
