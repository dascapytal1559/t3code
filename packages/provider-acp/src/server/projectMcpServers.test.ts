import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { parseProjectMcpServers, readProjectMcpServers } from "./projectMcpServers.ts";

it("maps .mcp.json servers to ACP shapes, expanding Claude Code's variables", () => {
  const parsed = parseProjectMcpServers(
    JSON.stringify({
      mcpServers: {
        archive: {
          type: "http",
          url: "${ARCHIVE_URL:-http://127.0.0.1:4650}/mcp",
          headers: { Authorization: "Bearer ${ARCHIVE_KEY}" },
        },
        open: { type: "http", url: "http://127.0.0.1:4700/mcp" },
        events: { type: "sse", url: "http://127.0.0.1:4800/sse", headers: { "X-Key": "k" } },
        local: { command: "${HOME}/bin/server", args: ["--root", "${ROOT:-.}"], env: { A: "1" } },
        typed: { type: "stdio", command: "/bin/typed" },
        needsKey: { type: "http", url: "http://x/mcp", headers: { Authorization: "${NO_KEY}" } },
        socket: { type: "ws", url: "ws://127.0.0.1:1" },
        broken: { type: "http" },
      },
    }),
    { ARCHIVE_KEY: "secret", HOME: "/home/me" },
  );
  assert.deepStrictEqual(parsed, {
    servers: [
      {
        type: "http",
        name: "archive",
        url: "http://127.0.0.1:4650/mcp",
        headers: [{ name: "Authorization", value: "Bearer secret" }],
      },
      { type: "http", name: "open", url: "http://127.0.0.1:4700/mcp", headers: [] },
      {
        type: "sse",
        name: "events",
        url: "http://127.0.0.1:4800/sse",
        headers: [{ name: "X-Key", value: "k" }],
      },
      {
        name: "local",
        command: "/home/me/bin/server",
        args: ["--root", "."],
        env: [{ name: "A", value: "1" }],
      },
      { name: "typed", command: "/bin/typed", args: [], env: [] },
    ],
    skipped: [
      { name: "needsKey", reason: "unset variables NO_KEY" },
      { name: "socket", reason: "not a stdio, http or sse server" },
      { name: "broken", reason: "not a stdio, http or sse server" },
    ],
  });
});

it("rejects a file that is not an mcpServers object", () => {
  for (const text of ["{", "[]", "{}", '{"mcpServers":[]}']) {
    assert.strictEqual(parseProjectMcpServers(text, {}), undefined, text);
  }
});

it.layer(NodeServices.layer)((it) => {
  it.effect("reads the folder's .mcp.json, none when absent or invalid", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-project-mcp-" });
      const read = readProjectMcpServers({ cwd, environment: {}, reservedNames: ["t3-code"] });

      assert.deepStrictEqual(yield* read, []);

      yield* fileSystem.writeFileString(path.join(cwd, ".mcp.json"), "{ not json");
      assert.deepStrictEqual(yield* read, []);

      yield* fileSystem.writeFileString(
        path.join(cwd, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            "t3-code": { type: "http", url: "http://127.0.0.1:1/mcp" },
            baby: { type: "http", url: "http://127.0.0.1:4660/mcp" },
          },
        }),
      );
      assert.deepStrictEqual(yield* read, [
        { type: "http", name: "baby", url: "http://127.0.0.1:4660/mcp", headers: [] },
      ]);
    }).pipe(Effect.scoped),
  );
});
