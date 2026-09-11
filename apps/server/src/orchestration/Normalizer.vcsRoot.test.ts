// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { type ClientOrchestrationCommand, CommandId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";

const testLayer = Layer.mergeAll(
  WorkspacePaths.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-normalizer-vcs-root-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

function metaUpdate(vcsRoot: string | null): ClientOrchestrationCommand {
  return {
    type: "project.meta.update",
    commandId: CommandId.make("command-1"),
    projectId: ProjectId.make("project-1"),
    vcsRoot,
  };
}

describe("normalizeDispatchCommand vcsRoot", () => {
  it.effect("stores an existing absolute directory as given", () =>
    Effect.gen(function* () {
      const repoDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-vcs-root-"));
      const normalized = yield* normalizeDispatchCommand(metaUpdate(`${repoDir}${NodePath.sep}`));
      expect(normalized).toEqual({ ...metaUpdate(repoDir) });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("passes null through so the override can be cleared", () =>
    Effect.gen(function* () {
      const normalized = yield* normalizeDispatchCommand(metaUpdate(null));
      expect(normalized).toEqual(metaUpdate(null));
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a relative path instead of resolving it against the server cwd", () =>
    Effect.gen(function* () {
      const result = yield* normalizeDispatchCommand(metaUpdate("packages/app")).pipe(Effect.flip);
      expect(result.message).toContain("absolute");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a directory that does not exist", () =>
    Effect.gen(function* () {
      const missing = NodePath.join(NodeOS.tmpdir(), "t3-vcs-root-missing-never-created");
      const result = yield* normalizeDispatchCommand(metaUpdate(missing)).pipe(Effect.flip);
      expect(result.message).toContain(missing);
    }).pipe(Effect.provide(testLayer)),
  );
});
