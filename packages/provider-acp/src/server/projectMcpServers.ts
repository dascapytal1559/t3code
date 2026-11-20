// A project folder's `.mcp.json`, in Claude Code's format, as ACP session MCP servers.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const PROJECT_MCP_CONFIG_FILE = ".mcp.json";

const StringRecord = Schema.Record(Schema.String, Schema.String);
const ProjectMcpFile = Schema.fromJsonString(
  Schema.Struct({ mcpServers: Schema.Record(Schema.String, Schema.Unknown) }),
);
const ProjectMcpServer = Schema.Union([
  Schema.Struct({
    type: Schema.optional(Schema.Literal("stdio")),
    command: Schema.NonEmptyString,
    args: Schema.optional(Schema.Array(Schema.String)),
    env: Schema.optional(StringRecord),
  }),
  Schema.Struct({
    type: Schema.Literals(["http", "sse"]),
    url: Schema.NonEmptyString,
    headers: Schema.optional(StringRecord),
  }),
]);
const decodeProjectMcpFile = Schema.decodeUnknownOption(ProjectMcpFile);
const decodeProjectMcpServer = Schema.decodeUnknownOption(ProjectMcpServer);

// Claude Code's grammar: `${NAME}`, or `${NAME:-default}` when NAME is unset.
const VARIABLE_PATTERN = /\$\{([^}]+)\}/g;

function expandVariables(
  text: string,
  environment: NodeJS.ProcessEnv,
  missing: Set<string>,
): string {
  return text.replace(VARIABLE_PATTERN, (match, body: string) => {
    const separator = body.indexOf(":-");
    const name = separator === -1 ? body : body.slice(0, separator);
    const value = environment[name];
    if (value !== undefined) return value;
    if (separator !== -1) return body.slice(separator + 2);
    missing.add(name);
    return match;
  });
}

const toPairs = (record: Readonly<Record<string, string>> | undefined) =>
  Object.entries(record ?? {}).map(([name, value]) => ({ name, value }));

interface Pair {
  readonly name: string;
  readonly value: string;
}

/** The ACP session shapes: stdio carries no `type`, as ACP v1 sends it. */
export type ProjectMcpServer =
  | {
      readonly name: string;
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: ReadonlyArray<Pair>;
    }
  | {
      readonly type: "http" | "sse";
      readonly name: string;
      readonly url: string;
      readonly headers: ReadonlyArray<Pair>;
    };

export interface ProjectMcpServers {
  readonly servers: ReadonlyArray<ProjectMcpServer>;
  /** Server names left out, with why. Never carries a value from the file. */
  readonly skipped: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
}

/** `undefined` when the file is not a `{ "mcpServers": { ... } }` JSON object. */
export function parseProjectMcpServers(
  text: string,
  environment: NodeJS.ProcessEnv,
): ProjectMcpServers | undefined {
  const file = decodeProjectMcpFile(text);
  if (Option.isNone(file)) return undefined;
  const servers: Array<ProjectMcpServer> = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const [name, entry] of Object.entries(file.value.mcpServers)) {
    const decoded = decodeProjectMcpServer(entry);
    if (Option.isNone(decoded)) {
      skipped.push({ name, reason: "not a stdio, http or sse server" });
      continue;
    }
    const server = decoded.value;
    const missing = new Set<string>();
    const expand = (value: string) => expandVariables(value, environment, missing);
    const expandRecord = (record: Readonly<Record<string, string>> | undefined) =>
      record === undefined
        ? undefined
        : Object.fromEntries(Object.entries(record).map(([key, value]) => [key, expand(value)]));
    const mapped: ProjectMcpServer =
      "command" in server
        ? {
            name,
            command: expand(server.command),
            args: (server.args ?? []).map(expand),
            env: toPairs(expandRecord(server.env)),
          }
        : {
            type: server.type,
            name,
            url: expand(server.url),
            headers: toPairs(expandRecord(server.headers)),
          };
    if (missing.size > 0) {
      skipped.push({ name, reason: `unset variables ${[...missing].join(", ")}` });
      continue;
    }
    servers.push(mapped);
  }
  return { servers, skipped };
}

/**
 * The servers `<cwd>/.mcp.json` declares; none when the file is absent or unreadable.
 * `reservedNames` are servers T3 already supplies, which a project file cannot replace.
 */
export const readProjectMcpServers = Effect.fn("readProjectMcpServers")(function* (input: {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly reservedNames?: ReadonlyArray<string>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(input.cwd, PROJECT_MCP_CONFIG_FILE);
  const text = yield* fileSystem.readFileString(file).pipe(
    Effect.asSome,
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeedNone,
    ),
    Effect.catch(() =>
      Effect.logWarning("Could not read the project's MCP config.", { file }).pipe(
        Effect.as(Option.none<string>()),
      ),
    ),
  );
  if (Option.isNone(text)) return [];
  const parsed = parseProjectMcpServers(text.value, input.environment);
  if (parsed === undefined) {
    yield* Effect.logWarning("Ignoring an invalid project MCP config.", { file });
    return [];
  }
  const reserved = new Set(input.reservedNames ?? []);
  const skipped = [
    ...parsed.skipped,
    ...parsed.servers
      .filter((server) => reserved.has(server.name))
      .map((server) => ({ name: server.name, reason: "T3 already provides it" })),
  ];
  if (skipped.length > 0) {
    yield* Effect.logWarning("Skipped servers from the project's MCP config.", { file, skipped });
  }
  return parsed.servers.filter((server) => !reserved.has(server.name));
});
