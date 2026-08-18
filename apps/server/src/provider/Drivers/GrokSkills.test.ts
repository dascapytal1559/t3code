import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import { discoverGrokSkills, parseGrokInspectSkills } from "./GrokSkills.ts";

const inspectReport = JSON.stringify({
  grokVersion: "1.0.4",
  skills: [
    {
      name: "review-pr",
      description: "Review a pull request.",
      source: { type: "project", path: "/repo/.grok/skills/review-pr/SKILL.md" },
      userInvocable: true,
    },
    {
      name: "commit",
      description: "Create conventional commits.",
      source: { type: "user", path: "/home/user/.grok/skills/commit/SKILL.md" },
      userInvocable: true,
    },
    {
      name: "canvas",
      source: { type: "bundled", path: "/home/user/.grok/bundled/skills/canvas/SKILL.md" },
      userInvocable: false,
    },
  ],
});

describe("parseGrokInspectSkills", () => {
  it("maps inspect skill entries and sorts them by name", () => {
    const skills = parseGrokInspectSkills(inspectReport);
    expect(skills).toEqual([
      {
        // Not user-invocable in Grok's own slash menu, so hidden from the
        // `$` picker as well.
        name: "canvas",
        path: "/home/user/.grok/bundled/skills/canvas/SKILL.md",
        enabled: false,
        scope: "bundled",
      },
      {
        name: "commit",
        path: "/home/user/.grok/skills/commit/SKILL.md",
        enabled: true,
        scope: "user",
        description: "Create conventional commits.",
      },
      {
        name: "review-pr",
        path: "/repo/.grok/skills/review-pr/SKILL.md",
        enabled: true,
        scope: "project",
        description: "Review a pull request.",
      },
    ]);
  });

  it("marks skills reported as disabled", () => {
    const skills = parseGrokInspectSkills(
      JSON.stringify({
        skills: [
          {
            name: "wip-skill",
            disabled: true,
            source: { type: "user", path: "/home/user/.grok/skills/wip-skill/SKILL.md" },
          },
        ],
      }),
    );
    expect(skills).toEqual([
      {
        name: "wip-skill",
        path: "/home/user/.grok/skills/wip-skill/SKILL.md",
        enabled: false,
        scope: "user",
      },
    ]);
  });

  it("skips entries without a name or SKILL.md path", () => {
    const skills = parseGrokInspectSkills(
      JSON.stringify({
        skills: [
          { name: "  ", source: { type: "user", path: "/skills/a/SKILL.md" } },
          { name: "no-source" },
          { name: "no-path", source: { type: "user" } },
          "not-an-object",
          { name: "kept", source: { type: "user", path: "/skills/kept/SKILL.md" } },
        ],
      }),
    );
    expect(skills.map((skill) => skill.name)).toEqual(["kept"]);
  });

  it("returns an empty list for malformed or unexpected payloads", () => {
    expect(parseGrokInspectSkills("not json")).toEqual([]);
    expect(parseGrokInspectSkills("null")).toEqual([]);
    expect(parseGrokInspectSkills(JSON.stringify({ skills: "nope" }))).toEqual([]);
    expect(parseGrokInspectSkills(JSON.stringify({ grokVersion: "1.0.4" }))).toEqual([]);
  });
});

it.layer(NodeServices.layer)("discoverGrokSkills", (it) => {
  const writeFakeGrok = (script: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-skills-" });
      const grokPath = path.join(dir, "grok");
      yield* fs.writeFileString(grokPath, script);
      yield* fs.chmod(grokPath, 0o755);
      return grokPath;
    });

  it.effect("returns the skills reported by `grok inspect --json`", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const grokPath = yield* writeFakeGrok(
          [
            "#!/bin/sh",
            'if [ "$1" = "inspect" ] && [ "$2" = "--json" ]; then',
            `  cat <<'REPORT'`,
            inspectReport,
            "REPORT",
            "  exit 0",
            "fi",
            "exit 1",
            "",
          ].join("\n"),
        );

        const skills = yield* discoverGrokSkills({ binaryPath: grokPath }, undefined);
        expect(skills.map((skill) => skill.name)).toEqual(["canvas", "commit", "review-pr"]);
      }),
    ),
  );

  it.effect("runs the probe in the provided workspace directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-workspace-" });
        const grokPath = yield* writeFakeGrok(
          [
            "#!/bin/sh",
            `printf '{"skills":[{"name":"where","source":{"type":"local","path":"'%s'/SKILL.md"}}]}' "$(pwd)"`,
            "",
          ].join("\n"),
        );

        const skills = yield* discoverGrokSkills({ binaryPath: grokPath }, workspace);
        expect(skills).toHaveLength(1);
        // Compare against the resolved path: on macOS the temp dir is a
        // symlink (/var -> /private/var), and `pwd` reports the real one.
        const realWorkspace = yield* fs.realPath(workspace);
        expect(skills[0]?.path).toBe(path.join(realWorkspace, "SKILL.md"));
      }),
    ),
  );

  it.effect("fails with a probe error when the probe exits non-zero", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const grokPath = yield* writeFakeGrok(["#!/bin/sh", "exit 3", ""].join("\n"));
        const result = yield* Effect.result(
          discoverGrokSkills({ binaryPath: grokPath }, undefined),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("ProviderSkillProbeError");
          expect(result.failure.detail).toContain("exited with code 3");
        }
      }),
    ),
  );

  it.effect("fails with a probe error when the binary is missing", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        discoverGrokSkills({ binaryPath: "/definitely/not/installed/grok-binary" }, undefined),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("ProviderSkillProbeError");
      }
    }),
  );
});
