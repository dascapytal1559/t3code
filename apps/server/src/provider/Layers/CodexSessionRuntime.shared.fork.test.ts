// Fork: Shared Codex desktop backend (FORK_FEATURES.md).
import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexRpc from "effect-codex-app-server/rpc";

import { openCodexThread, readSharedCodexTurns } from "./CodexSessionRuntime.ts";

const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

const makeThread = (
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/read"]["thread"] =>
  ({
    id: threadId,
    createdAt: "2026-04-18T00:00:00.000Z",
    source: { session: "cli" },
    turns: [],
    status: { state: "idle", activeFlags: [] },
  }) as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/read"]["thread"];

describe("shared history before the first turn", () => {
  const unavailable = new CodexErrors.CodexAppServerRequestError({
    code: -32601,
    errorMessage: "list_turns is not supported yet",
  });

  it.effect("allows a newly created task to reach its first turn", () =>
    Effect.gen(function* () {
      const turns = yield* readSharedCodexTurns(Effect.fail(unavailable), true);
      NodeAssert.deepStrictEqual(turns, []);
    }),
  );

  it.effect("preserves that error for a resumed task or one with an observed turn", () =>
    Effect.gen(function* () {
      const error = yield* readSharedCodexTurns(Effect.fail(unavailable), false).pipe(Effect.flip);
      NodeAssert.strictEqual(error, unavailable);
    }),
  );

  it.effect("does not hide other failures on a new task", () =>
    Effect.gen(function* () {
      const failure = new CodexErrors.CodexAppServerRequestError({
        code: -32603,
        errorMessage: "history could not be read",
      });
      const error = yield* readSharedCodexTurns(Effect.fail(failure), true).pipe(Effect.flip);
      NodeAssert.strictEqual(error, failure);
    }),
  );

  it.effect("retains intervening history even when the task was created here", () =>
    Effect.gen(function* () {
      const thread = makeThread("native-thread");
      const turns = [{ id: "desktop-turn", items: [], status: "completed" as const, error: null }];
      const result = yield* readSharedCodexTurns(
        Effect.succeed({ thread: { ...thread, turns } }),
        true,
      );
      NodeAssert.deepStrictEqual(result, turns);
    }),
  );
});

it.effect("never replaces a missing shared conversation with a fresh task", () =>
  Effect.gen(function* () {
    const client = {
      request: () => Effect.die("Shared mode must never start a replacement thread"),
      raw: {
        request: () =>
          Effect.fail(
            new CodexErrors.CodexAppServerRequestError({
              code: -32603,
              errorMessage: "no rollout found for thread id promised-thread",
            }),
          ),
      },
    };
    const error = yield* openCodexThread({
      client,
      threadId: ThreadId.make("thread-1"),
      runtimeMode: "full-access",
      cwd: "/tmp/project",
      requestedModel: undefined,
      serviceTier: undefined,
      resumeThreadId: "promised-thread",
      sharedDesktop: true,
    }).pipe(Effect.flip);
    NodeAssert.ok(isCodexAppServerRequestError(error));
    NodeAssert.match(error.message, /no rollout found/);
  }),
);
