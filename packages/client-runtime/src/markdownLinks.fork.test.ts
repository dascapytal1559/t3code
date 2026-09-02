// Fork: tilde paths stay plain in chat (FORK_FEATURES.md). A `~/` path may
// refer to another machine's home, so it must not become a local link.
import { describe, expect, it } from "vite-plus/test";

import { inlineCodeFilePathCandidate } from "./markdownLinks.js";

describe("inlineCodeFilePathCandidate (fork)", () => {
  it.each(["~/basedcapital/harness", "~/notes.md", "~/src/main.ts:12", "~\\notes.md"])(
    "leaves the tilde path %s as plain code",
    (source) => {
      expect(inlineCodeFilePathCandidate(source)).toBeNull();
    },
  );
});
