import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

/** One line of the register, as `apps/server/scripts/session-register-hook.sh` writes it. */
const RegisterLine = Schema.Struct({
  v: Schema.Literal(1),
  sessionId: Schema.NonEmptyString,
  startedAt: Schema.String,
  provider: Schema.String,
  cwd: Schema.optionalKey(Schema.String),
  /** `T3CODE_THREAD_ID` in the session's environment. */
  threadId: Schema.optionalKey(Schema.NonEmptyString),
  /** `FM_TASK_ID` and `FM_HOME` in the session's environment. */
  fmTaskId: Schema.optionalKey(Schema.NonEmptyString),
  fmHome: Schema.optionalKey(Schema.NonEmptyString),
});
const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(RegisterLine));

/** An agent session's start and the environment it inherited. */
export type SessionRegistration = Omit<typeof RegisterLine.Type, "v" | "startedAt"> & {
  readonly startedAtMs: number;
};

/** Malformed lines, such as one cut short by a full disk, are skipped. */
function parseRegister(text: string): SessionRegistration[] {
  return text.split("\n").flatMap((raw): SessionRegistration[] => {
    const line = Option.getOrUndefined(decodeLine(raw));
    if (line === undefined) return [];
    const { v: _version, startedAt, ...registration } = line;
    const startedAtMs = Date.parse(startedAt);
    return Number.isNaN(startedAtMs) ? [] : [{ ...registration, startedAtMs }];
  });
}

/** The hook appends to one file per UTC month, so a read opens only the months it covers. */
export function registerFileNames(fromMs: number, untilMs: number): string[] {
  const monthIndex = (ms: number) => {
    const { year, month } = DateTime.toPartsUtc(DateTime.makeUnsafe(ms));
    return year * 12 + month - 1;
  };
  const names: string[] = [];
  for (let month = monthIndex(fromMs); month <= monthIndex(untilMs); month++) {
    names.push(`${Math.floor(month / 12)}-${String((month % 12) + 1).padStart(2, "0")}.jsonl`);
  }
  return names;
}

/**
 * The session register: one line per agent session start, appended by the session-start hook that
 * Claude, Codex and Grok each run. It lives in files, not the database, so it needs no running
 * server and a T3 restart never loses a registration.
 */
export class UsageSessionRegister extends Context.Service<
  UsageSessionRegister,
  {
    /** Sessions started in `[fromMs, untilMs)`; an unreadable register reads as empty. */
    readonly read: (fromMs: number, untilMs: number) => Effect.Effect<SessionRegistration[]>;
  }
>()("t3/usage/UsageSessionRegister") {}

export const REGISTER_FOLDER_NAME = "session-register";

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = path.join(config.stateDir, REGISTER_FOLDER_NAME);

  const readFile = (name: string) =>
    fileSystem.readFileString(path.join(folder, name)).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(""),
      ),
      Effect.tapError((error) => Effect.logWarning("Could not read the session register.", error)),
      Effect.orElseSucceed(() => ""),
    );

  const read = Effect.fn("UsageSessionRegister.read")(function* (fromMs: number, untilMs: number) {
    const texts = yield* Effect.forEach(registerFileNames(fromMs, untilMs), readFile, {
      concurrency: "unbounded",
    });
    return texts
      .flatMap(parseRegister)
      .filter(({ startedAtMs }) => startedAtMs >= fromMs && startedAtMs < untilMs);
  });

  return UsageSessionRegister.of({ read });
});

export const layer = Layer.effect(UsageSessionRegister, make);
