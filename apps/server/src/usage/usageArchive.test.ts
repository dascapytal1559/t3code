// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { discoverUsageArchive, upgradeArchivedScanCache } from "./usageArchive.ts";
import { decodeScanCache } from "./usageScanCache.ts";
import { TEST_FORMAT_MAP } from "./usageTestFormats.ts";

let root: string;

const write = async (relative: string, content = "{}\n") => {
  const file = NodePath.join(root, relative);
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  await NodeFSP.writeFile(file, content);
};

beforeEach(async () => {
  root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-archive-test-"));
});

afterEach(async () => {
  await NodeFSP.rm(root, { recursive: true, force: true });
});

describe("discoverUsageArchive", () => {
  it("finds transcripts and saved T3 usage under each host, labelled by host and instance", async () => {
    await write("remote-a/home/.claude/projects/app/session.jsonl");
    await write("remote-a/home/.claude-profiles/z/projects/app/session.jsonl");
    await write("remote-a/home/.codex/sessions/2026/08/01/rollout-1.jsonl");
    await write("remote-a/home/.grok/sessions/%2Fhome/turn-1/updates.jsonl");
    await write("remote-a/home/.t3/userdata/usage-scan-cache-v5.json");
    await write("remote-a/home/.t3/userdata/usage-scan-cache.json");
    await write("laptop-old/projects/app/session.jsonl");
    await write("remote-b/old-t3/usage-scan-cache.json");
    // Not transcripts: names alone are not enough.
    await write("remote-a/home/code/projects/notes.md");
    await write("remote-a/home/.pi/agent/sessions/notes.md");
    await write("remote-a/home/code/node_modules/x/projects/app/session.jsonl");
    await write("MANIFEST.md", "# Archive\n");

    const archive = await discoverUsageArchive([root, NodePath.join(root, "missing")]);

    expect(
      archive.transcripts
        .map(({ host, instance, provider, dir }) => ({
          host,
          instance,
          provider,
          dir: NodePath.relative(root, dir),
        }))
        .toSorted((a, b) => a.dir.localeCompare(b.dir)),
    ).toEqual([
      { host: "laptop-old", instance: ".", provider: "claude", dir: "laptop-old/projects" },
      {
        host: "remote-a",
        instance: "home/.claude-profiles/z",
        provider: "claude",
        dir: "remote-a/home/.claude-profiles/z/projects",
      },
      {
        host: "remote-a",
        instance: "home/.claude",
        provider: "claude",
        dir: "remote-a/home/.claude/projects",
      },
      {
        host: "remote-a",
        instance: "home/.codex",
        provider: "codex",
        dir: "remote-a/home/.codex/sessions",
      },
      {
        host: "remote-a",
        instance: "home/.grok",
        provider: "grok",
        dir: "remote-a/home/.grok/sessions",
      },
    ]);
    expect(archive.transcripts.find((dir) => dir.provider === "grok")?.fileName).toBe(
      "updates.jsonl",
    );
    expect(
      archive.caches
        .map(({ host, instance, file }) => ({
          host,
          instance,
          file: NodePath.relative(root, file),
        }))
        .toSorted((a, b) => a.file.localeCompare(b.file)),
    ).toEqual([
      {
        host: "remote-a",
        instance: "home/.t3/userdata",
        file: "remote-a/home/.t3/userdata/usage-scan-cache-v5.json",
      },
      { host: "remote-b", instance: "old-t3", file: "remote-b/old-t3/usage-scan-cache.json" },
    ]);
  });

  it("reads a version 3 server cache at standard speed", () => {
    const row = [1_786_000_000_000, 0, 0, 2, 100, 10, 50, 0, "msg_1:req_1", null];
    const document = {
      version: 3,
      models: ["claude-fable-5"],
      sessions: ["session-a"],
      files: {
        "/home/remote/.claude/projects/app/gone.jsonl": {
          s: 10,
          m: 1_786_000_000_000,
          p: "claude",
          r: [row],
          t: [],
          o: 10,
          gl: 0,
          gh: 0,
          cs: null,
        },
      },
    };

    expect(decodeScanCache(document, TEST_FORMAT_MAP).size).toBe(0);
    const [entry] = decodeScanCache(upgradeArchivedScanCache(document), TEST_FORMAT_MAP).values();
    expect(entry?.records).toEqual([
      expect.objectContaining({
        sessionId: "session-a",
        speed: "standard",
        dedupeKey: "msg_1:req_1",
        totals: expect.objectContaining({ outputTokens: 50 }),
      }),
    ]);
  });
});
