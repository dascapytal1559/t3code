// Fork: import a Codex or Claude session by id (FORK_FEATURES.md). Covers the
// pasted-reference parser the command palette feeds into agentSessions.importThread.
import { describe, expect, it } from "@effect/vitest";

import { parseAgentSessionThreadReference } from "./agentSessions.ts";

const CODEX_ID = "01a07bb0-b316-7bd2-8074-aacf1e1d1422";
const CLAUDE_ID = "123e4567-e89b-42d3-a456-426614174000";

describe("parseAgentSessionThreadReference", () => {
  it("reads codex://threads links, ignoring case, whitespace, and a trailing slash", () => {
    expect(parseAgentSessionThreadReference(`  codex://threads/${CODEX_ID}/ `)).toEqual({
      source: "codex",
      providerSessionId: CODEX_ID,
    });
    expect(parseAgentSessionThreadReference(`CODEX://THREADS/${CODEX_ID.toUpperCase()}`)).toEqual({
      source: "codex",
      providerSessionId: CODEX_ID,
    });
  });

  it("routes bare ids by UUID version: v7 to Codex, v4 to Claude Code", () => {
    expect(parseAgentSessionThreadReference(CODEX_ID)).toEqual({
      source: "codex",
      providerSessionId: CODEX_ID,
    });
    expect(parseAgentSessionThreadReference(CLAUDE_ID)).toEqual({
      source: "claudeAgent",
      providerSessionId: CLAUDE_ID,
    });
  });

  it("rejects anything else", () => {
    expect(parseAgentSessionThreadReference("")).toBeNull();
    expect(parseAgentSessionThreadReference("new thread")).toBeNull();
    expect(parseAgentSessionThreadReference("codex://threads/")).toBeNull();
    expect(
      parseAgentSessionThreadReference("codex://threads/not-a-uuid-at-all-not-a-uuid-at"),
    ).toBeNull();
    // A UUID of another version names no known provider.
    expect(parseAgentSessionThreadReference("123e4567-e89b-12d3-a456-426614174000")).toBeNull();
    expect(parseAgentSessionThreadReference(`https://example.com/${CODEX_ID}`)).toBeNull();
  });
});
