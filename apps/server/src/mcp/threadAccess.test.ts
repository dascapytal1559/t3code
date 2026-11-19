import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
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
import * as UsageOrigins from "../usage/UsageOrigins.ts";
import {
  assertTargetWithinLimits,
  bindUsageOrigin,
  readThread,
  verifyCause,
} from "./threadAccess.ts";
import type { ProjectionRecordFilter } from "../orchestration-v2/ProjectionStore.ts";

const bareId = ThreadId.make("5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04");
const claudeCode: McpInvocationContext.McpClientCaller = {
  sessionId: "thread-access",
  label: "Claude Code",
  access: "full-access",
};
const client: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:thread-access"),
  requestNamespace: "client:thread-access",
  thread: undefined,
  client: claudeCode,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const linksHint =
  "Thread ids belong to one environment: for a thread on a linked one, find it with `t3_environment_links` and pass its `environmentId` to a tool that takes one.";

const readBare = (
  existing: ReadonlyArray<OrchestrationV2ThreadShell | ThreadId>,
  scope: McpInvocationContext.McpInvocationScope = client,
  threadId: ThreadId = bareId,
) => {
  const shells = existing.map((shell) =>
    typeof shell === "string" ? liveThreadShell(shell) : shell,
  );
  return readThread(threadId).pipe(
    Effect.flip,
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(shells.find((shell) => shell.id === threadId) ?? null),
      }),
    ),
  );
};

it.effect("points a bare uuid at the mcp: thread it belongs to", () =>
  Effect.gen(function* () {
    const error = yield* readBare([ThreadId.make(`mcp:${bareId}`)]);

    expect(error.code).toBe("thread_not_found");
    expect(error.message).toBe(
      `The thread was not found. Did you mean \`mcp:${bareId}\`? ${linksHint}`,
    );
  }),
);

it.effect("tells a caller with linked environments that the thread may be on one of them", () =>
  Effect.gen(function* () {
    const error = yield* readBare([], { ...client, linkedEnvironments: true });

    expect(error.code).toBe("thread_not_found");
    expect(error.message).toContain("t3_environment_links");
    expect(error.message).toContain("environmentId");

    const linksOff = yield* readBare([], { ...client, linkedEnvironments: false });
    expect(linksOff.message).toBe("The thread was not found.");
    const peerLink = yield* readBare([], {
      ...client,
      linkedEnvironments: true,
      client: { ...claudeCode, linked: true },
    });
    expect(peerLink.message).toBe("The thread was not found.");

    // A thread a fenced link started may not use this environment's links.
    const fencedThread = ThreadId.make("thread:started-by-fenced-link");
    const fenced = yield* readBare(
      [
        {
          ...liveThreadShell(fencedThread),
          linkOrigin: { sessionId: "peer-session", label: "Laptop", access: "auto" },
        },
      ],
      {
        ...client,
        linkedEnvironments: true,
        client: undefined,
        thread: {
          threadId: fencedThread,
          providerSessionId: "provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
      },
    );
    expect(fenced.message).toBe("The thread was not found.");
  }),
);

it.effect("points an unencoded delegated-task id at the encoded thread it belongs to", () =>
  Effect.gen(function* () {
    const commandId = `command:mcp:${bareId}:delegate-task:0e7d2c41-6b9a-4f3e-8d15-a2c4b6e8f019`;
    const encoded = ThreadId.make(`thread:delegated-task:${encodeURIComponent(commandId)}`);
    const error = yield* readBare(
      [encoded],
      client,
      ThreadId.make(`thread:delegated-task:${commandId}`),
    );

    expect(error.code).toBe("thread_not_found");
    expect(error.message).toContain(`\`${encoded}\``);
  }),
);

it.effect("identifies the target and effective caller ceiling when a thread write is refused", () =>
  Effect.gen(function* () {
    for (const [runtimeMode, interactionMode, code] of [
      ["approval-required", "default", "runtime_mode_escalation_denied"],
      ["full-access", "plan", "interaction_mode_escalation_denied"],
      ["approval-required", "plan", "runtime_mode_escalation_denied"],
    ] as const) {
      const target = liveThreadShell(bareId, { runtimeMode: "full-access" });
      const error = yield* assertTargetWithinLimits({ runtimeMode, interactionMode }, target).pipe(
        Effect.flip,
      );

      expect(error.code).toBe(code);
      expect(error.message).toContain(bareId);
      expect(error.message).toContain("full-access/default");
      expect(error.message).toContain(`${runtimeMode}/${interactionMode}`);
      expect(error.message).not.toMatch(/child|parent mode/i);
    }
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

it.effect("binds work a thread sends only from that thread's own turn", () =>
  Effect.gen(function* () {
    const caller = ThreadId.make("thread:caller");
    const other = ThreadId.make("thread:other");
    const threads = {
      getThreadShell: (threadId: ThreadId) => Effect.succeed(liveThreadShell(threadId)),
    };
    const asked: Array<readonly [string, number]> = [];
    const bind = (fromThread: ThreadId, at?: string) =>
      bindUsageOrigin(
        threads,
        { threadId: fromThread, ...(at === undefined ? {} : { at }) },
        caller,
      ).pipe(
        Effect.provide(
          Layer.mock(UsageOrigins.UsageOrigins)({
            originAt: (threadId, atMs) =>
              Effect.sync(() => asked.push([threadId, atMs])).pipe(
                Effect.as({
                  key: {
                    origin: "phone",
                    basis: "stamp",
                    reason: "typed",
                    root: { threadId, messageId: "message:typed" },
                  },
                  reroots: true,
                  runId: null,
                  atMs,
                }),
              ),
          }),
        ),
      );

    expect(yield* Effect.flip(bind(other))).toMatchObject({
      code: "invalid_request",
      message: "fromThread: an agent in a thread speaks only for its own thread.",
    });
    // A thread's agent cannot pick an earlier typed turn to re-root what it sends.
    expect(yield* Effect.flip(bind(caller, "1970-01-01T00:00:00.000Z"))).toMatchObject({
      code: "invalid_request",
    });
    expect(asked).toEqual([]);
    yield* bind(caller);
    expect(asked).toEqual([[caller, DateTime.toEpochMillis(yield* DateTime.now)]]);
  }),
);
