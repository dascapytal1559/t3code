import { RestartRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

const RestartRequestJson = Schema.fromJsonString(RestartRequest);
const decodeRequest = Schema.decodeUnknownEffect(RestartRequestJson);
const encodeRequest = Schema.encodeEffect(RestartRequestJson);

/**
 * The pending restart request, kept on disk so the server start it leads to knows what it was
 * for. Opening it takes the request a previous process left, null when the restart was not
 * requested (a crash or a manual restart), and removes it so the next start reads only its own.
 */
export const open = Effect.fn("RestartRequestFile.open")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(config.stateDir, "restart-request.json");

  const restartedFor = yield* fs.readFileString(filePath).pipe(
    Effect.flatMap(decodeRequest),
    Effect.orElseSucceed(() => null),
  );
  yield* fs.remove(filePath, { force: true }).pipe(Effect.ignore);

  // A lost write only loses the restart's cause, so it never fails the request.
  const save = (request: RestartRequest | null) =>
    (request === null
      ? fs.remove(filePath, { force: true })
      : encodeRequest(request).pipe(
          Effect.flatMap((contents) => fs.writeFileString(filePath, contents)),
        )
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not save the pending restart request", { cause }),
      ),
    );

  return { restartedFor, save };
});
