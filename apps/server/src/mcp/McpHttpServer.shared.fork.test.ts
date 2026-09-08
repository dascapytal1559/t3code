// Fork: Shared Codex desktop backend (FORK_FEATURES.md).
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpProtocol, McpSchema, McpServer } from "effect/unstable/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as Registry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-mcp-shared-test");

it.effect(
  "routes concurrent shared HTTP tool calls using native metadata and denies missing or revoked bindings",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* Registry.__testing.make().pipe(
          Effect.provideService(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(environmentId),
            getDescriptor: Effect.die("unused"),
          }),
        );
        for (const name of ["a", "b"]) {
          const issued = yield* registry.issue({
            threadId: ThreadId.make(name),
            providerInstanceId: ProviderInstanceId.make("codex"),
          });
          yield* registry.bindNativeThread(`native-${name}`, issued.config.providerSessionId);
        }
        const registration = Layer.effectDiscard(
          Effect.gen(function* () {
            const server = yield* McpServer.McpServer;
            yield* server.addTool({
              tool: new McpSchema.Tool({
                name: "identity",
                inputSchema: { type: "object", properties: {} },
              }),
              annotations: Context.empty(),
              handle: () =>
                Effect.withFiber((fiber) => {
                  const scope = Context.getUnsafe(
                    fiber.context,
                    McpInvocationContext.McpInvocationContext,
                  );
                  return scope
                    ? Effect.succeed(
                        new McpSchema.CallToolResult({
                          content: [{ type: "text", text: scope.threadId }],
                        }),
                      )
                    : Effect.die("Missing request scope");
                }),
            });
          }),
        );
        const serverLayer = registration.pipe(
          Layer.provideMerge(
            McpServer.layerHttp({
              name: "Shared routing test",
              version: "1",
              path: "/mcp",
              protocols: [McpProtocol.v2025_06_18],
            }).pipe(Layer.provide(McpHttpServer.McpAuthMiddlewareLive)),
          ),
          Layer.provide(Layer.succeed(Registry.McpSessionRegistry, registry)),
        );
        yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
          Layer.build,
        );
        const http = yield* HttpClient.HttpClient;
        const post = (body: unknown, sessionId?: string) =>
          http.post("/mcp", {
            headers: {
              accept: "application/json, text/event-stream",
              authorization: registry.sharedCredential.authorizationHeader,
              ...(sessionId
                ? { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" }
                : {}),
            },
            body: HttpBody.text(JSON.stringify(body), "application/json"),
          });
        const initialized = yield* post({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "shared-test", version: "1" },
          },
        });
        expect(initialized.status).toBe(200);
        const sessionId = initialized.headers["mcp-session-id"];
        yield* post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, sessionId);
        const transportHeaders = {
          accept: "text/event-stream",
          authorization: registry.sharedCredential.authorizationHeader,
          "mcp-session-id": sessionId!,
          "mcp-protocol-version": "2025-06-18",
        };
        expect((yield* http.get("/mcp", { headers: transportHeaders })).status).toBe(405);
        expect((yield* http.get("/mcp")).status).toBe(401);
        const discovered = yield* post(
          {
            jsonrpc: "2.0",
            id: "discovery",
            method: "tools/list",
            // Codex supplies progress metadata before it has a task identity.
            params: { _meta: { progressToken: 0 } },
          },
          sessionId,
        );
        expect(discovered.status).toBe(200);
        expect(yield* discovered.text).toContain('"name":"identity"');
        for (const method of ["resources/list", "resources/templates/list", "prompts/list"]) {
          const discovery = yield* post(
            { jsonrpc: "2.0", id: method, method, params: { _meta: { progressToken: 1 } } },
            sessionId,
          );
          // Unsupported optional inventories are protocol errors, not a
          // rejected login that makes Codex discard this server's tools.
          expect(discovery.status).not.toBe(401);
        }
        const call = (name?: string) =>
          post(
            {
              jsonrpc: "2.0",
              id: name ?? "missing",
              method: "tools/call",
              params: {
                name: "identity",
                arguments: {},
                ...(name ? { _meta: { threadId: `native-${name}` } } : {}),
              },
            },
            sessionId,
          );
        const results = yield* Effect.all(
          ["a", "b"].map((name) =>
            call(name).pipe(
              Effect.flatMap((response) =>
                response.text.pipe(Effect.map((text) => ({ status: response.status, text }))),
              ),
            ),
          ),
          { concurrency: "unbounded" },
        );
        expect(results[0]).toMatchObject({
          status: 200,
          text: expect.stringContaining('"text":"a"'),
        });
        expect(results[1]).toMatchObject({
          status: 200,
          text: expect.stringContaining('"text":"b"'),
        });
        expect((yield* call()).status).toBe(401);
        yield* registry.revokeThread(ThreadId.make("a"));
        expect((yield* call("a")).status).toBe(401);
        expect((yield* call("b")).status).toBe(200);
        const replaced = yield* registry.issue({
          threadId: ThreadId.make("a"),
          providerInstanceId: ProviderInstanceId.make("codex"),
        });
        yield* registry.bindNativeThread("native-a", replaced.config.providerSessionId);
        expect((yield* call("a")).status).toBe(200);
        expect((yield* http.del("/mcp", { headers: transportHeaders })).status).toBe(204);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest.pipe(Layer.provideMerge(NodeServices.layer)))),
);
