import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Workflows from "../../../workflows/Workflows.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as WorkflowHandlers from "./handlers.ts";
import { WorkflowToolkit } from "./tools.ts";

const handlersWith = (
  workflows: Partial<Workflows.Workflows["Service"]>,
  access: "full-access" | "auto" = "full-access",
) =>
  McpToolAccess.HandlersLayer.layer(WorkflowHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        NodeCrypto.layer,
        McpToolAccessTestkit.liveThreadsLayer,
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("environment:workflow"),
          requestNamespace: "client:workflow",
          thread: undefined,
          client: { sessionId: "session-1", label: "t3 CLI", access },
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
        }),
        Layer.mock(Workflows.Workflows)(workflows),
      ),
    ),
  );

it.effect("start passes an explicit null payload through and defaults an omitted one to {}", () =>
  Effect.gen(function* () {
    const payloads: Array<unknown> = [];
    yield* Effect.gen(function* () {
      const toolkit = yield* WorkflowToolkit;
      for (const input of [{ input: null }, {}]) {
        yield* toolkit
          .handle("t3_workflow", {
            action: "start",
            workflow: "echo",
            idempotencyKey: "trial",
            ...input,
          })
          .pipe(Stream.unwrap, Stream.runCollect);
      }
    }).pipe(
      Effect.provide(
        handlersWith({
          start: (_workflow, input) =>
            Effect.sync(() => {
              payloads.push(input);
              return { runId: "run-1" };
            }),
          get: () => Effect.succeed({ run: undefined, steps: [], references: [] } as never),
        }),
      ),
    );
    expect(payloads).toEqual([null, {}]);
  }),
);

it.effect("signal refuses a run destination mixed with a channel destination", () =>
  Effect.gen(function* () {
    const delivered: Array<unknown> = [];
    const results = yield* Effect.gen(function* () {
      const toolkit = yield* WorkflowToolkit;
      return yield* Effect.forEach(
        [
          { runId: "run-1", wait: "review", channel: "other" },
          { workflow: "other", channel: "other", runId: "run-1" },
          { runId: "run-1", wait: "review" },
        ],
        (address) =>
          toolkit
            .handle("t3_workflow", { action: "signal", value: { choice: "yes" }, ...address })
            .pipe(
              Stream.unwrap,
              Stream.runCollect,
              Effect.map((parts) => parts.at(-1)?.result),
            ),
      );
    }).pipe(
      Effect.provide(
        handlersWith({
          signal: (address) =>
            Effect.sync(() => {
              delivered.push(address);
              return "delivered" as const;
            }),
        }),
      ),
    );
    for (const result of results.slice(0, -1)) {
      expect(result).toMatchObject({ code: "invalid_request" });
    }
    expect(results.at(-1)).toEqual({ delivery: "delivered" });
    expect(delivered).toEqual([{ runId: "run-1", wait: "review" }]);
  }),
);

// Fork: a workflow's agents can run above the caller's mode, so writes need full access.
it.effect.each([
  { action: "start", workflow: "echo", idempotencyKey: "trial" },
  { action: "hooks" },
  { action: "signal", runId: "run-1", wait: "ship", value: true },
  { action: "resume", runId: "run-1" },
  { action: "cancel", runId: "run-1" },
  { action: "store_set", key: "k", value: 1 },
  { action: "store_delete", key: "k" },
] as const)("$action is refused for a client below full access", (input) =>
  Effect.gen(function* () {
    const toolkit = yield* WorkflowToolkit;
    const results = yield* toolkit
      .handle("t3_workflow", input)
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(results.at(-1)?.result).toMatchObject({
      message: expect.stringContaining("full-access"),
    });
  }).pipe(Effect.provide(handlersWith({}, "auto"))),
);
