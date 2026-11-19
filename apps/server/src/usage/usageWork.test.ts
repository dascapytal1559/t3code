// @effect-diagnostics nodeBuiltinImport:off - builds real folders, git links and session files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { ProjectId, type UsageWorkGroup } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import {
  canonicalFolder,
  encodeClaudeFolder,
  makeUsageWork,
  readCodexSessionFolder,
  type WorkFolders,
  type WorkProject,
} from "./usageWork.ts";

let root: string;

const at = (...parts: string[]) => NodePath.join(root, ...parts);
const write = async (relative: string, content: string | Buffer) => {
  const file = at(relative);
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  await NodeFSP.writeFile(file, content);
};
/** A repository at `repo` with a linked worktree at `worktree`, as `git worktree add` leaves them. */
const linkWorktree = async (repo: string, worktree: string, name: string) => {
  await NodeFSP.mkdir(at(repo, ".git", "worktrees", name), { recursive: true });
  await write(`${repo}/.git/worktrees/${name}/commondir`, "../..\n");
  await write(`${repo}/.git/worktrees/${name}/gitdir`, `${at(worktree, ".git")}\n`);
  await write(`${worktree}/.git`, `gitdir: ${at(repo, ".git", "worktrees", name)}\n`);
};

const project = (id: string, folder: string): WorkProject => ({
  id: ProjectId.make(id),
  root: at(folder),
});
const groups = (entries: Record<string, readonly string[]>): readonly UsageWorkGroup[] =>
  Object.entries(entries).map(([name, ids]) => ({
    name,
    projectIds: ids.map((id) => ProjectId.make(id)),
  }));
const seen = (
  cwds: readonly string[],
  files: Record<string, { provider: "claude" | "codex"; sourceDir: string }> = {},
): WorkFolders => ({ cwds: new Set(cwds), files: new Map(Object.entries(files)) });

beforeEach(async () => {
  root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-work-test-")),
  );
  await NodeFSP.mkdir(at("app", ".git"), { recursive: true });
  await NodeFSP.mkdir(at("trader", ".git"), { recursive: true });
});

afterEach(async () => {
  await NodeFSP.rm(root, { recursive: true, force: true });
});

describe("canonicalFolder", () => {
  it("places a linked worktree's folders in its repository's main working tree", async () => {
    await linkWorktree("app", "pool/7/app", "app1");
    await NodeFSP.mkdir(at("pool/7/app/src"), { recursive: true });

    expect(await canonicalFolder(at("pool/7/app/src"))).toBe(at("app", "src"));
    expect(await canonicalFolder(at("app/src"))).toBe(at("app", "src"));
    expect(await canonicalFolder(at("elsewhere"))).toBe(at("elsewhere"));
  });
});

describe("makeUsageWork", () => {
  const make = (
    options: { repos?: Record<string, string>; codex?: Record<string, string> } = {},
  ) => {
    const codexReads: string[] = [];
    const work = makeUsageWork({
      homeDir: at("home"),
      foldersCachePath: at("state", "usage-session-folders.json"),
      readNoMistakesRepos: () => new Map(Object.entries(options.repos ?? {})),
      readCodexSessionFolder: async (filePath) => {
        codexReads.push(filePath);
        return options.codex?.[filePath] ?? null;
      },
    });
    return { work, codexReads };
  };
  const projects = () => [
    project("app", "app"),
    project("app-docs", "app/docs"),
    project("trader", "trader"),
    project("home", "home"),
  ];
  const assigned = groups({ Tooling: ["app"], Docs: ["app-docs"], Trading: ["trader"] });

  it("counts a folder to the group of the deepest project holding it, worktrees by their repository", async () => {
    await linkWorktree("app", "pool/7/app", "app1");
    await NodeFSP.mkdir(at("pool/7/app/docs/guide"), { recursive: true });
    const { work } = make();
    const folders = [
      at("app"),
      at("app/docs/guide"),
      at("pool/7/app"),
      at("pool/7/app/docs/guide"),
      at("trader/bin"),
      at("home/notes"),
      at("tmp/scratch"),
      // A removed worktree places by the thread that ran in it.
      at("pool/9/gone/src"),
    ];
    const removed = [{ path: at("pool/9/gone"), projectId: ProjectId.make("trader") }];

    const placed = await work.attribution(assigned, projects(), removed, seen(folders), 0);

    expect(folders.map((cwd) => placed.groupOf(cwd, undefined))).toEqual([
      "Tooling",
      "Docs",
      "Tooling",
      "Docs",
      "Trading",
      // A project in no group, and a folder in no project, count as Other.
      null,
      null,
      "Trading",
    ]);
    expect(placed.groups).toEqual(["Tooling", "Docs", "Trading"]);
  });

  it("counts a pipeline review to the repository no-mistakes reviewed, even once its worktree is gone", async () => {
    const { work } = make({ repos: { abc123: at("trader") } });
    const review = at("home", ".no-mistakes", "worktrees", "abc123", "run-9", "src");
    const bare = at("home", ".no-mistakes", "repos", "abc123.git");
    const unknown = at("home", ".no-mistakes", "worktrees", "fff000", "run-1");

    const placed = await work.attribution(
      assigned,
      projects(),
      [],
      seen([review, bare, unknown]),
      0,
    );

    expect(placed.groupOf(review, undefined)).toBe("Trading");
    expect(placed.groupOf(bare, undefined)).toBe("Trading");
    expect(placed.groupOf(unknown, undefined)).toBeNull();
  });

  it("places a Claude transcript with no folder by its encoded folder name, worktrees included", async () => {
    await linkWorktree("app", "pool/7/app", "app1");
    const { work } = make({ repos: { abc123: at("trader") } });
    const claudeDir = at("home", ".claude", "projects");
    const transcript = (folder: string) =>
      NodePath.join(claudeDir, encodeClaudeFolder(folder), "session.jsonl");
    const files = {
      [transcript(at("app/docs"))]: { provider: "claude" as const, sourceDir: claudeDir },
      [transcript(at("pool/7/app/src"))]: { provider: "claude" as const, sourceDir: claudeDir },
      [transcript(at("home/.no-mistakes/worktrees/abc123/run-2"))]: {
        provider: "claude" as const,
        sourceDir: claudeDir,
      },
      [transcript(at("tmp/x"))]: { provider: "claude" as const, sourceDir: claudeDir },
      [transcript(at("pool/9/gone"))]: { provider: "claude" as const, sourceDir: claudeDir },
      [NodePath.join(claudeDir, encodeClaudeFolder(at("trader")), "s1", "subagents", "a.jsonl")]: {
        provider: "claude" as const,
        sourceDir: claudeDir,
      },
    };

    const removed = [{ path: at("pool/9/gone"), projectId: ProjectId.make("app") }];
    const placed = await work.attribution(assigned, projects(), removed, seen([], files), 0);

    expect(Object.keys(files).map((filePath) => placed.groupOf(undefined, filePath))).toEqual([
      "Docs",
      "Tooling",
      "Trading",
      null,
      "Tooling",
      "Trading",
    ]);
  });

  it("reads each Codex session's first-line folder once, keeping it on disk for later servers", async () => {
    const session = at("home", ".codex", "sessions", "rollout-1.jsonl.zst");
    const options = { codex: { [session]: at("trader") } };
    const files = { [session]: { provider: "codex" as const, sourceDir: at("home/.codex") } };
    const first = make(options);

    const placed = await first.work.attribution(assigned, projects(), [], seen([], files), 0);
    await first.work.attribution(assigned, projects(), [], seen([], files), 0);
    const restarted = make(options);
    const again = await restarted.work.attribution(assigned, projects(), [], seen([], files), 0);

    expect(placed.groupOf(undefined, session)).toBe("Trading");
    expect(again.groupOf(undefined, session)).toBe("Trading");
    expect(first.codexReads).toEqual([session]);
    expect(restarted.codexReads).toEqual([]);
  });

  it("prefers a record's own folder over its transcript's", async () => {
    const session = at("home", ".codex", "sessions", "rollout-2.jsonl");
    const { work } = make({ codex: { [session]: at("trader") } });
    const files = { [session]: { provider: "codex" as const, sourceDir: at("home/.codex") } };

    const placed = await work.attribution(assigned, projects(), [], seen([at("app")], files), 0);

    expect(placed.groupOf(at("app"), session)).toBe("Tooling");
    expect(placed.groupOf(undefined, session)).toBe("Trading");
  });
});

describe("readCodexSessionFolder", () => {
  it("reads the working folder from a session's first line, compressed or not", async () => {
    const meta = `${JSON.stringify({ type: "session_meta", payload: { cwd: "/work/app" } })}\n`;
    const turn = `${JSON.stringify({ type: "turn_context", payload: { cwd: "/elsewhere" } })}\n`;
    await write("plain.jsonl", meta + turn);
    await write("packed.jsonl.zst", NodeZlib.zstdCompressSync(Buffer.from(meta + turn)));
    await write("bare.jsonl", `${JSON.stringify({ type: "session_meta", payload: {} })}\n`);

    expect(await readCodexSessionFolder(at("plain.jsonl"))).toBe("/work/app");
    expect(await readCodexSessionFolder(at("packed.jsonl.zst"))).toBe("/work/app");
    expect(await readCodexSessionFolder(at("bare.jsonl"))).toBeNull();
    expect(await readCodexSessionFolder(at("missing.jsonl"))).toBeNull();
  });
});
