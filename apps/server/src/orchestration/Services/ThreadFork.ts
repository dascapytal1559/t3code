/**
 * ThreadFork - Fork a thread into a new thread that continues from one of
 * its turns (FORK_FEATURES.md: Fork a thread).
 *
 * Owns the ordering around a `thread.create` command carrying `forkedFrom`:
 * validate the fork point against the source thread's turns, derive the
 * provider session binding the fork starts from, dispatch the create (whose
 * projectors copy the history), persist the binding, and copy the source's
 * checkpoint refs under the fork's namespace.
 *
 * @module ThreadFork
 */
import type { OrchestrationCommand } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import type { ProviderSessionDirectoryWriteError } from "../../provider/Services/ProviderSessionDirectory.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";

export type ThreadForkCommand = Extract<OrchestrationCommand, { type: "thread.create" }> & {
  readonly forkedFrom: NonNullable<
    Extract<OrchestrationCommand, { type: "thread.create" }>["forkedFrom"]
  >;
};

export type ThreadForkError =
  | ProjectionRepositoryError
  | ProviderServiceError
  | ProviderSessionDirectoryWriteError
  | OrchestrationDispatchError;

export interface ThreadForkShape {
  /**
   * Run the fork. `dispatch` is the caller's command dispatcher so origin
   * attribution follows the connection that asked. Resolves with the create
   * event's sequence; a failure after the thread was created deletes it again.
   */
  readonly forkThread: (input: {
    readonly command: ThreadForkCommand;
    readonly dispatch: (
      command: OrchestrationCommand,
    ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchError>;
  }) => Effect.Effect<{ readonly sequence: number }, ThreadForkError>;
}

export class ThreadFork extends Context.Service<ThreadFork, ThreadForkShape>()(
  "t3/orchestration/Services/ThreadFork",
) {}
