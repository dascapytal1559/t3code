// Fork: Shared Codex desktop backend (FORK_FEATURES.md).
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const fakeHttpServer = HttpServer.HttpServer.of({
  address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 43123 },
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-1")),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = (now: () => number) =>
  McpSessionRegistry.__testing
    .make({ now, livenessWindowMs: 100 })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    );

it.effect("routes a shared credential by native task and respects revocation and recovery", () =>
  Effect.gen(function* () {
    let now = 1000;
    const registry = yield* makeRegistry(() => now);
    const token = registry.sharedCredential.authorizationHeader.slice(7);
    expect(yield* registry.authenticateShared(token)).toBe(true);
    expect(yield* registry.resolve(token)).toBeUndefined();
    const issue = (id: string) =>
      registry.issue({
        threadId: ThreadId.make(id),
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
    const a = yield* issue("a");
    const b = yield* issue("b");
    expect(yield* registry.bindNativeThread("native-a", "unissued-session")).toBe(false);
    yield* registry.bindNativeThread("native-a", a.config.providerSessionId);
    yield* registry.bindNativeThread("native-b", b.config.providerSessionId);
    expect(yield* registry.bindNativeThread("native-a", b.config.providerSessionId)).toBe(false);
    const scopes = yield* Effect.all(
      [registry.resolveNativeThread("native-a"), registry.resolveNativeThread("native-b")],
      { concurrency: "unbounded" },
    );
    expect(scopes.map((scope) => scope?.threadId)).toEqual(["a", "b"]);
    yield* registry.revokeThread(ThreadId.make("a"));
    expect(yield* registry.resolveNativeThread("native-a")).toBeUndefined();
    const replacement = yield* issue("a");
    yield* registry.bindNativeThread("native-a", replacement.config.providerSessionId);
    expect((yield* registry.resolveNativeThread("native-a"))?.providerSessionId).toBe(
      replacement.config.providerSessionId,
    );
    now += 101;
    expect(yield* registry.resolveNativeThread("native-a")).toBeUndefined();
    expect(yield* registry.resolveNativeThread("native-b")).toBeUndefined();
  }),
);
