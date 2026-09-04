import { CommandId, type ThreadId, type TurnId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import {
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProviderValidationError } from "../../provider/Errors.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import { ThreadFork, type ThreadForkShape } from "../Services/ThreadFork.ts";
import { resolveForkCutoff } from "../threadFork.ts";

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const providerService = yield* ProviderService;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const threadDeletionReactor = yield* ThreadDeletionReactor;

  const forkValidationError = (issue: string) =>
    new ProviderValidationError({ operation: "ThreadFork.forkThread", issue });

  /**
   * Checkpoint refs are hidden git refs keyed by thread id, so the fork gets
   * its own copies of every inherited ref (plus the turn-0 baseline). Best
   * effort: a workspace without git simply has no checkpoints to inherit,
   * and a copy failure leaves the fork's checkpoints "missing", the same
   * state a thread reaches when its own capture fails.
   */
  const copyCheckpointRefs = Effect.fn("ThreadFork.copyCheckpointRefs")(function* (input: {
    readonly sourceThreadId: ThreadId;
    readonly targetThreadId: ThreadId;
    readonly keptTurns: ReadonlyArray<{
      readonly checkpointRef: string | null;
      readonly checkpointTurnCount: number | null;
    }>;
  }) {
    const source = yield* projectionSnapshotQuery.getThreadDetailById(input.sourceThreadId, {
      activityKinds: [],
    });
    if (Option.isNone(source)) {
      return;
    }
    const project = yield* projectionSnapshotQuery.getProjectShellById(source.value.projectId);
    const cwd = resolveThreadWorkspaceCwd({
      thread: source.value,
      projects: Option.isSome(project) ? [project.value] : [],
    });
    if (cwd === undefined || !isGitRepository(cwd)) {
      return;
    }
    const refs = [
      {
        from: checkpointRefForThreadTurn(input.sourceThreadId, 0),
        to: checkpointRefForThreadTurn(input.targetThreadId, 0),
      },
      ...input.keptTurns.flatMap((turn) =>
        turn.checkpointTurnCount === null
          ? []
          : [
              {
                from: checkpointRefForThreadTurn(input.sourceThreadId, turn.checkpointTurnCount),
                to: checkpointRefForThreadTurn(input.targetThreadId, turn.checkpointTurnCount),
              },
            ],
      ),
    ];
    yield* checkpointStore.copyCheckpointRefs({ cwd, refs });
  });

  const forkThread: ThreadForkShape["forkThread"] = Effect.fn("ThreadFork.forkThread")(function* ({
    command,
    dispatch,
  }) {
    const sourceThreadId = command.forkedFrom.threadId;
    const forkTurnId: TurnId = command.forkedFrom.turnId;

    const sourceTurns = yield* projectionTurnRepository.listByThreadId({
      threadId: sourceThreadId,
    });
    const cutoff = resolveForkCutoff(sourceTurns, forkTurnId);
    const forkTurn = sourceTurns.find((turn) => turn.turnId === forkTurnId);
    if (cutoff === null || forkTurn === undefined) {
      return yield* forkValidationError(
        `Turn '${forkTurnId}' is not a turn of thread '${sourceThreadId}'.`,
      );
    }
    if (forkTurn.state === "running" || forkTurn.state === "pending") {
      return yield* forkValidationError("This turn is still running and cannot be forked yet.");
    }
    const turnIds = sourceTurns.flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId]));
    const binding = yield* providerService.prepareForkedSessionBinding({
      sourceThreadId,
      targetThreadId: command.threadId,
      turnId: forkTurnId,
      turnOrdinal: cutoff.retainedTurnIds.size,
      isLatestTurn: turnIds.at(-1) === forkTurnId,
    });

    const created = yield* dispatch(command);
    // Same fence as a plain create: the deletion reactor must finish with
    // any prior incarnation of this thread id before it owns resources.
    yield* threadDeletionReactor.drainThrough(created.sequence);

    const deleteCreatedThread = crypto.randomUUIDv4.pipe(
      Effect.flatMap((uuid) =>
        dispatch({
          type: "thread.delete",
          commandId: CommandId.make(`server:fork-thread-delete:${uuid}`),
          threadId: command.threadId,
        }),
      ),
      Effect.ignoreCause({ log: true }),
    );

    yield* providerSessionDirectory
      .upsert(binding)
      .pipe(
        Effect.onError((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.void : deleteCreatedThread,
        ),
      );

    yield* copyCheckpointRefs({
      sourceThreadId,
      targetThreadId: command.threadId,
      keptTurns: sourceTurns.filter(
        (turn) => turn.turnId !== null && cutoff.retainedTurnIds.has(turn.turnId),
      ),
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("thread fork could not copy checkpoint refs", {
              sourceThreadId,
              threadId: command.threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    );

    return { sequence: created.sequence };
  });

  return { forkThread } satisfies ThreadForkShape;
});

export const ThreadForkLive = Layer.effect(ThreadFork, make);
