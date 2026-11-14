import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { MessageId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as UsageClaims from "./UsageClaims.ts";

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "a folder claim is stored at its real path and removed by the linked path once deleted",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const claims = yield* UsageClaims.UsageClaims;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3-usage-claims-" });
      yield* fs.makeDirectory(path.join(base, "real", "run1"), { recursive: true });
      yield* fs.symlink(path.join(base, "real"), path.join(base, "link"));
      const linked = path.join(base, "link", "run1");
      const stored = path.join(yield* fs.realPath(base), "real", "run1");
      const causedBy = { threadId: ThreadId.make("lead"), messageId: MessageId.make("prompt") };

      yield* claims.claim({ target: { kind: "directory", directory: linked }, causedBy });
      assert.deepStrictEqual(yield* claims.read, [
        { kind: "directory", target: stored, causeMessageId: "prompt" },
      ]);

      yield* fs.remove(path.join(base, "real", "run1"), { recursive: true });
      const removed = yield* claims.claim({
        target: { kind: "directory", directory: linked },
        causedBy: null,
      });
      assert.deepStrictEqual(removed.target, { kind: "directory", directory: stored });
      assert.deepStrictEqual(yield* claims.read, []);
    }).pipe(
      Effect.provide(
        UsageClaims.layer.pipe(
          Layer.provideMerge(Layer.merge(Sqlite.layerMemory, NodeServices.layer)),
        ),
      ),
    ),
);
