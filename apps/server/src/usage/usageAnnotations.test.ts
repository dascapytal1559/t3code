import { UsageDay } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readUsageAnnotations, USAGE_ANNOTATIONS_FILE_NAME } from "./usageAnnotations.ts";

const readWith = (content: string | undefined) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-usage-annotations-" });
    const file = path.join(dir, USAGE_ANNOTATIONS_FILE_NAME);
    if (content !== undefined) yield* fileSystem.writeFileString(file, content);
    return yield* readUsageAnnotations(file);
  });

describe("readUsageAnnotations", () => {
  it.effect("reads no annotations when the file is missing", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* readWith(undefined), []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores a file that is not JSON or not a list of annotations", () =>
    Effect.gen(function* () {
      for (const content of [
        "[{",
        '{ "date": "2026-03-04", "label": "Launch" }',
        '[{ "date": "March 4", "label": "Launch" }]',
        '[{ "date": "2026-03-04", "label": "  " }]',
        '[{ "date": "2026-03-04", "label": "Launch", "logo": "unknown" }]',
      ]) {
        assert.deepStrictEqual(yield* readWith(content), [], content);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads each annotation's date, label and logo", () =>
    Effect.gen(function* () {
      const annotations = yield* readWith(
        JSON.stringify([
          { date: "2026-03-04", label: "Launch" },
          { date: "2026-05-20", label: "New editor +", logo: "t3" },
        ]),
      );
      assert.deepStrictEqual(annotations, [
        { date: UsageDay.make("2026-03-04"), label: "Launch" },
        { date: UsageDay.make("2026-05-20"), label: "New editor +", logo: "t3" },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
