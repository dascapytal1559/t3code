// Fork: desktop runs a swappable server payload (FORK_FEATURES.md).
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";

const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
  isPackaged: false,
  resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const makeEnvironment = (overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput>) =>
  DesktopEnvironment.DesktopEnvironment.pipe(
    Effect.provide(
      DesktopEnvironment.layer({ ...defaultInput, ...overrides }).pipe(
        Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))),
      ),
    ),
  );

describe("DesktopEnvironment (fork)", () => {
  it.effect("prefers a server root override in packaged builds only", () =>
    Effect.gen(function* () {
      const packaged = yield* makeEnvironment({
        isPackaged: true,
        appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
        serverRootOverride: "/Users/alice/.t3/fork/builds/abc123",
      });
      const development = yield* makeEnvironment({
        serverRootOverride: "/Users/alice/.t3/fork/builds/abc123",
      });

      assert.equal(packaged.serverRoot, "/Users/alice/.t3/fork/builds/abc123");
      assert.equal(
        packaged.backendEntryPath,
        "/Users/alice/.t3/fork/builds/abc123/apps/server/dist/bin.mjs",
      );
      assert.equal(packaged.appRoot, "/Applications/T3 Code.app/Contents/Resources/app.asar");
      assert.equal(development.serverRoot, "/repo");
    }),
  );
});
