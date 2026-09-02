// Fork: lazy per-directory file explorer (FORK_FEATURES.md). Clients gate the
// lazy explorer on this capability and silently fall back to upstream's capped
// listEntries flow without it, so a merge that drops the flag must fail here.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "./ServerEnvironment.ts";

const makeServerEnvironmentLayer = (baseDir: string) =>
  ServerEnvironment.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  );

it.layer(NodeServices.layer)("ServerEnvironmentLive (fork)", (it) => {
  it.effect("advertises the workspaceDirectoryListing capability", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-environment-fork-test-",
      });

      const descriptor = yield* Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
        return yield* serverEnvironment.getDescriptor;
      }).pipe(Effect.provide(makeServerEnvironmentLayer(baseDir)));

      expect(descriptor.capabilities.workspaceDirectoryListing).toBe(true);
    }),
  );
});
