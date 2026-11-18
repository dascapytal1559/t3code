/**
 * Fork feature: dated notes the server owner keeps beside T3's own data, drawn on the Usage
 * chart. The file is local to this server and only travels in its usage summaries.
 */
import { UsageAnnotation } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

export const USAGE_ANNOTATIONS_FILE_NAME = "usage-annotations.json";

const decodeAnnotations = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(UsageAnnotation)),
);

/** No file means no annotations; a file that does not read as annotations is logged and ignored. */
export const readUsageAnnotations = Effect.fn("UsageService.readAnnotations")(function* (
  filePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  if (!(yield* fileSystem.exists(filePath).pipe(Effect.orElseSucceed(() => false)))) return [];
  return yield* fileSystem.readFileString(filePath).pipe(
    Effect.flatMap(decodeAnnotations),
    Effect.catchCause((cause) =>
      Effect.logWarning("Usage annotations file was ignored", { filePath, cause }).pipe(
        Effect.as<readonly UsageAnnotation[]>([]),
      ),
    ),
  );
});
