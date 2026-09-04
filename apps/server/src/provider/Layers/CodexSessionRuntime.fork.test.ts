// Fork: Fork a thread (FORK_FEATURES.md) — the Codex open path forks the
// source app-server thread through the seeded turn instead of resuming it.
import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";

import { openCodexThread } from "./CodexSessionRuntime.ts";

type OpenMethod = "thread/start" | "thread/resume" | "thread/fork";

const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

function makeOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/fork"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "danger-full-access" },
    thread: {
      id: threadId,
      forkedFromId: "source-thread",
      createdAt: "2026-04-18T00:00:00.000Z",
      source: { session: "cli" },
      turns: [],
      status: { state: "idle", activeFlags: [] },
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/fork"];
}

describe("openCodexThread fork", () => {
  it.effect("calls thread/fork through the seeded turn with the start params", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: OpenMethod; payload: unknown }> = [];
      const client = {
        request: <M extends OpenMethod>(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push({ method, payload });
          return Effect.succeed(
            makeOpenResponse("forked-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
          );
        },
      };

      const opened = yield* openCodexThread({
        client,
        threadId: ThreadId.make("fork"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "source-thread",
        forkLastTurnId: "turn-2",
      });

      NodeAssert.equal(opened.thread.id, "forked-thread");
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["thread/fork"],
      );
      const payload = calls[0]?.payload as Record<string, unknown>;
      NodeAssert.equal(payload.threadId, "source-thread");
      NodeAssert.equal(payload.lastTurnId, "turn-2");
      NodeAssert.equal(payload.cwd, "/tmp/project");
      NodeAssert.equal(payload.model, "gpt-5.3-codex");
    }),
  );

  it.effect("never falls back to a fresh thread when the fork fails", () =>
    Effect.gen(function* () {
      const calls: Array<OpenMethod> = [];
      const client = {
        request: <M extends OpenMethod>(
          method: M,
          _payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push(method);
          return Effect.fail(
            new CodexErrors.CodexAppServerRequestError({
              code: -32603,
              errorMessage: "thread not found",
            }),
          );
        },
      };

      const error = yield* openCodexThread({
        client,
        threadId: ThreadId.make("fork"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: undefined,
        serviceTier: undefined,
        resumeThreadId: "source-thread",
        forkLastTurnId: "turn-2",
      }).pipe(Effect.flip);

      NodeAssert.ok(isCodexAppServerRequestError(error));
      NodeAssert.deepStrictEqual(calls, ["thread/fork"]);
    }),
  );
});
