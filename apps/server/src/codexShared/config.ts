// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
// Standalone launch boundary: runs before T3 and owns native process pipes.
import * as Schema from "effect/Schema";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const AbsolutePath = Schema.String.pipe(Schema.check(Schema.makeFilter(NodePath.isAbsolute)));

export const SharedCodexConfig = Schema.Struct({
  version: Schema.Literal(1),
  appPath: AbsolutePath,
  binaryPath: AbsolutePath,
  nodePath: AbsolutePath,
  codexHome: AbsolutePath,
  stateDirectory: AbsolutePath,
  launcherPath: AbsolutePath,
});
export type SharedCodexConfig = typeof SharedCodexConfig.Type;

export const SharedCodexState = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  url: Schema.String,
  codexHome: AbsolutePath,
  appToolsPipe: Schema.String,
  backendPid: Schema.Number,
  appPid: Schema.Number,
  controlToken: Schema.String,
});
export type SharedCodexState = typeof SharedCodexState.Type;

export const SharedMcpBackup = Schema.Struct({ value: Schema.Unknown });
export const sharedMcpBackupPath = (config: SharedCodexConfig) =>
  NodePath.join(config.stateDirectory, "mcp-previous.json");

export const sharedStatePath = (config: SharedCodexConfig) =>
  NodePath.join(config.stateDirectory, "backend.json");
export const sharedControlPath = (config: SharedCodexConfig) =>
  NodePath.join(config.stateDirectory, "control.sock");

const decodeConfig = Schema.decodeUnknownSync(Schema.fromJsonString(SharedCodexConfig));
const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(SharedCodexState));

export async function readSharedConfig(path: string): Promise<SharedCodexConfig> {
  return decodeConfig(await NodeFSP.readFile(path, "utf8"));
}

export async function readSharedState(config: SharedCodexConfig): Promise<SharedCodexState> {
  const state = decodeState(await NodeFSP.readFile(sharedStatePath(config), "utf8"));
  const url = new URL(state.url);
  if (
    url.protocol !== "ws:" ||
    url.hostname !== "127.0.0.1" ||
    state.codexHome !== config.codexHome
  ) {
    throw new Error("Shared Codex state does not match the configured local backend.");
  }
  return state;
}
