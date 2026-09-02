// Fork: tilde paths stay plain in chat (FORK_FEATURES.md).
import { describe, expect, it } from "vite-plus/test";

import { resolveInlineCodeFileLinkMeta } from "./markdown-links";

describe("resolveInlineCodeFileLinkMeta (fork)", () => {
  it("leaves tilde paths as plain code — they may refer to another machine's home", () => {
    expect(
      resolveInlineCodeFileLinkMeta("~/basedcapital/harness", "/Users/julius/project"),
    ).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("~/notes.md", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("~/src/main.ts:12", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("~\\notes.md", "/Users/julius/project")).toBeNull();
  });
});
