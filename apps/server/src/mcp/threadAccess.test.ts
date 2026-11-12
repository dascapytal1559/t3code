import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
  type OrchestrationV2CausedBy,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import { readThread, verifyCause } from "./threadAccess.ts";
import type { ProjectionRecordFilter } from "../orchestration-v2/ProjectionStore.ts";

const bareId = ThreadId.make("5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04");
const client: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:thread-access"),
  requestNamespace: "client:thread-access",
  thread: undefined,
  client: { sessionId: "thread-access", label: "Claude Code", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const readBare = (existing: ReadonlyArray<ThreadId>) =>
  readThread(bareId).pipe(
    Effect.flip,
    Effect.provideService(McpInvocationContext.McpInvocationContext, client),
    Effect.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(existing.includes(threadId) ? liveThreadShell(threadId) : null),
      }),
    ),
  );

it.effect("points a bare uuid at the mcp: thread it belongs to", () =>
  Effect.gen(function* () {
    const error = yield* readBare([ThreadId.make(`mcp:${bareId}`)]);

    expect(error.code).toBe("thread_not_found");
    expect(error.message).toBe(`The thread was not found. Did you mean \`mcp:${bareId}\`?`);
  }),
);

it.effect("accepts a cause only for a prompt that exists in the named thread and run", () =>
  Effect.gen(function* () {
    const coordinator = ThreadId.make("thread:coordinator");
    const gone = ThreadId.make("thread:gone");
    const prompt = MessageId.make("message:prompt");
    const reply = MessageId.make("message:reply");
    const run = RunId.make("run:coordinator:1");
    const threads = {
      getThreadShell: (threadId: ThreadId) =>
        Effect.succeed(
          threadId === coordinator
            ? liveThreadShell(threadId)
            : threadId === gone
              ? { ...liveThreadShell(threadId), deletedAt: DateTime.makeUnsafe(0) }
              : null,
        ),
      getThreadRecords: (threadId: ThreadId, _fields: unknown, filter?: ProjectionRecordFilter) =>
        Effect.succeed({
          messages: [
            { id: prompt, threadId, runId: run, role: "user" },
            { id: reply, threadId, runId: run, role: "assistant" },
          ].filter(
            (message) => threadId === coordinator && filter?.messageIds?.includes(message.id),
          ),
        }),
    } as unknown as Parameters<typeof verifyCause>[0];
    const verify = (cause: OrchestrationV2CausedBy) =>
      verifyCause(threads, cause).pipe(
        Effect.match({ onFailure: (error) => error.message, onSuccess: () => "ok" }),
      );

    expect(yield* verify({ threadId: coordinator, messageId: prompt })).toBe("ok");
    expect(yield* verify({ threadId: coordinator, runId: run, messageId: prompt })).toBe("ok");
    expect(
      yield* verify({ threadId: coordinator, runId: RunId.make("run:other"), messageId: prompt }),
    ).toBe(`causedBy: message ${prompt} is not part of run run:other.`);
    expect(yield* verify({ threadId: coordinator, messageId: reply })).toBe(
      `causedBy: message ${reply} is not a prompt in thread ${coordinator}.`,
    );
    expect(
      yield* verify({ threadId: coordinator, messageId: MessageId.make("message:none") }),
    ).toBe(`causedBy: message message:none is not a prompt in thread ${coordinator}.`);
    expect(yield* verify({ threadId: gone, messageId: prompt })).toBe(
      `causedBy: thread ${gone} was not found.`,
    );
    expect(yield* verify({ threadId: ThreadId.make("thread:missing"), messageId: prompt })).toBe(
      "causedBy: thread thread:missing was not found.",
    );
  }),
);
