import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  forkedThreadTitle,
  providerSupportsThreadFork,
  resolveThreadForkTurnId,
} from "@t3tools/client-runtime/state/thread-fork";
import type { ScopedThreadRef, TurnId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { waitForStartedServerThread } from "../components/ChatView.logic";
import { newThreadId } from "../lib/utils";
import { readEnvironmentSupportsThreadFork, readThreadShell } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";

/**
 * Whether the fork actions should be offered for a thread at all: the server
 * must understand forkedFrom and the thread's provider must fork natively.
 * Threads that have not started yet have no provider, so they are excluded.
 */
export function readThreadForkSupported(threadRef: ScopedThreadRef): boolean {
  const shell = readThreadShell(threadRef);
  return (
    shell !== null &&
    readEnvironmentSupportsThreadFork(threadRef.environmentId) &&
    providerSupportsThreadFork(shell.session?.providerName)
  );
}

/**
 * Fork a thread through a turn (FORK_FEATURES.md: Fork a thread). Creates the
 * server thread, waits for its copied history to arrive, and opens it. With
 * no turn given, forks through the latest settled turn.
 */
export function useForkThread() {
  const router = useRouter();
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });

  return useCallback(
    async (
      threadRef: ScopedThreadRef,
      options?: { readonly turnId?: TurnId },
    ): Promise<AtomCommandResult<unknown, unknown> | null> => {
      const source = readThreadShell(threadRef);
      if (source === null) return null;
      const turnId = options?.turnId ?? resolveThreadForkTurnId(source);
      if (turnId === null) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Nothing to fork yet",
            description: "Wait for the current reply to finish, then fork the thread.",
          }),
        );
        return null;
      }
      const forkThreadId = newThreadId();
      const createdAt = new Date().toISOString();
      const result = await createThread({
        environmentId: threadRef.environmentId,
        input: {
          threadId: forkThreadId,
          projectId: source.projectId,
          title: forkedThreadTitle(source.title),
          modelSelection: source.modelSelection,
          runtimeMode: source.runtimeMode,
          interactionMode: source.interactionMode,
          branch: source.branch,
          worktreePath: source.worktreePath,
          forkedFrom: { threadId: threadRef.threadId, turnId },
          createdAt,
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not fork thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return result;
      }
      const forkRef = scopeThreadRef(threadRef.environmentId, forkThreadId);
      // The fork arrives with history, so it reads as started as soon as the
      // shell lands; the wait only bridges the create ack and the shell push.
      await settlePromise(() => waitForStartedServerThread(forkRef));
      await router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(forkRef),
      });
      return result;
    },
    [createThread, router],
  );
}
