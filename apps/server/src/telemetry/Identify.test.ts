import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";

import * as ServerConfig from "../config.ts";
import * as Identify from "./Identify.ts";

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

const makeCaptureLogger = (logs: CapturedLog[]) =>
  Logger.make(({ fiber, message }) => {
    logs.push({
      message,
      annotations: fiber.getRef(References.CurrentLogAnnotations),
    });
  });

const findIdentityLog = (logs: ReadonlyArray<CapturedLog>, source: string, errorTag: string) =>
  logs.find((log) => log.annotations.source === source && log.annotations.errorTag === errorTag);

const layerIdentity = (prefix: string, logs?: CapturedLog[]) =>
  ServerConfig.layerTest(process.cwd(), { prefix }).pipe(
    Layer.merge(
      logs === undefined
        ? Layer.empty
        : Logger.layer([makeCaptureLogger(logs)], { mergeWithExisting: false }),
    ),
  );

it.layer(NodeServices.layer)("telemetry identity", (it) => {
  it.effect("leaves no torn anonymous id behind when its write fails midway", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const tornWrites = FileSystem.FileSystem.of({
        ...fileSystem,
        writeFileString: (filePath, data, options) =>
          fileSystem
            .writeFileString(filePath, data.slice(0, Math.floor(data.length / 2)), options)
            .pipe(
              Effect.andThen(
                Effect.fail(
                  PlatformError.systemError({
                    _tag: "WriteZero",
                    module: "FileSystem",
                    method: "writeFileString",
                    pathOrDescriptor: filePath,
                  }),
                ),
              ),
            ),
      });

      const identity = yield* Identify.getTelemetryIdentity.pipe(
        Effect.provideService(FileSystem.FileSystem, tornWrites),
      );

      assert.deepEqual(identity, { distinctId: null, installId: null });
      assert.isFalse(yield* fileSystem.exists(config.anonymousIdPath));
    }).pipe(Effect.provide(layerIdentity("t3-telemetry-identify-torn-"))),
  );

  it.effect("does not overwrite the anonymous id path after a non-NotFound read failure", () => {
    const logs: CapturedLog[] = [];

    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.makeDirectory(config.anonymousIdPath);

      const identity = yield* Identify.getTelemetryIdentity;
      assert.deepEqual(identity, { distinctId: null, installId: null });
      assert.deepEqual(yield* fileSystem.readDirectory(config.anonymousIdPath), []);

      const readLog = findIdentityLog(logs, "anonymous", "TelemetryIdentityReadError");
      assert.equal(readLog?.annotations.filePath, config.anonymousIdPath);
      assert.notEqual(readLog?.annotations.platformReason, "NotFound");
      assert.notProperty(readLog?.annotations ?? {}, "cause");
      assert.isUndefined(
        findIdentityLog(logs, "anonymous", "TelemetryAnonymousIdPersistenceError"),
      );
    }).pipe(Effect.provide(layerIdentity("t3-telemetry-identify-read-", logs)));
  });
});
