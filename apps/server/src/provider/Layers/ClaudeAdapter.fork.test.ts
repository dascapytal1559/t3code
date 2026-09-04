// Fork: Claude session recovery after latched auth errors (FORK_FEATURES.md).
// The lifecycle half (warning + runtime recycle) needs the adapter harness and
// lives in ClaudeAdapter.test.ts as "fork: recycles the session ...". This
// file pins the result classification that triggers it.
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "@effect/vitest";

import { isClaudeAuthErrorResult } from "./ClaudeAdapter.ts";

const resultMessage = (fields: Record<string, unknown>): SDKResultMessage =>
  ({
    type: "result",
    num_turns: 1,
    session_id: "sdk-session-1",
    uuid: "result-1",
    ...fields,
  }) as unknown as SDKResultMessage;

describe("isClaudeAuthErrorResult", () => {
  it("recognises the CLI's logged-out latch as emitted in the field", () => {
    expect(
      isClaudeAuthErrorResult(
        resultMessage({
          subtype: "success",
          is_error: true,
          result: "Not logged in · Please run /login",
        }),
      ),
    ).toBe(true);
  });

  it.each([
    ["OAuth token has expired. Please run /login."],
    ["Failed to authenticate with the API."],
    ["Invalid API key · Fix external API key"],
    ["OAuth token revoked"],
  ])("recognises auth failures reported through result errors: %s", (error) => {
    expect(
      isClaudeAuthErrorResult(
        resultMessage({ subtype: "error_during_execution", is_error: true, errors: [error] }),
      ),
    ).toBe(true);
  });

  it("ignores successful results even when the text mentions login", () => {
    expect(
      isClaudeAuthErrorResult(
        resultMessage({
          subtype: "success",
          is_error: false,
          result: "Run /login to switch accounts.",
        }),
      ),
    ).toBe(false);
  });

  it("ignores unrelated errors so ordinary failures keep the runtime alive", () => {
    expect(
      isClaudeAuthErrorResult(
        resultMessage({
          subtype: "error_during_execution",
          is_error: true,
          errors: ["Rate limit exceeded", "[ede_diagnostic] retry budget exhausted"],
        }),
      ),
    ).toBe(false);
    expect(
      isClaudeAuthErrorResult(
        resultMessage({ subtype: "error_max_turns", is_error: true, errors: [] }),
      ),
    ).toBe(false);
  });
});

// Fork: Fork a thread (FORK_FEATURES.md) — the Claude fork seed cursor and the
// per-turn anchors it depends on.
import { ThreadId, TurnId } from "@t3tools/contracts";

import { buildClaudeForkResumeCursor } from "./ClaudeAdapter.ts";

describe("buildClaudeForkResumeCursor", () => {
  const sourceCursor = {
    threadId: "source",
    resume: "0f4c2a4e-6c8b-4d1a-9b8e-1c2d3e4f5a6b",
    resumeSessionAt: "uuid-a3",
    turnCount: 3,
    turnAnchors: [
      { turnId: "t1", uuid: "uuid-a1" },
      { turnId: "t2", uuid: "uuid-a2" },
      { turnId: "t3", uuid: "uuid-a3" },
    ],
  };

  it("anchors the fork at the chosen turn and keeps only the anchors before it", () => {
    expect(
      buildClaudeForkResumeCursor({
        sourceResumeCursor: sourceCursor,
        targetThreadId: ThreadId.make("fork"),
        turnId: TurnId.make("t2"),
        turnOrdinal: 2,
        isLatestTurn: false,
      }),
    ).toEqual({
      resumeCursor: {
        threadId: "fork",
        resume: sourceCursor.resume,
        resumeSessionAt: "uuid-a2",
        turnCount: 2,
        turnAnchors: sourceCursor.turnAnchors.slice(0, 2),
        forkSession: true,
      },
    });
  });

  it("forks the latest turn of a pre-anchor session through resumeSessionAt", () => {
    const legacyCursor = {
      threadId: "source",
      resume: sourceCursor.resume,
      resumeSessionAt: "uuid-last",
    };
    expect(
      buildClaudeForkResumeCursor({
        sourceResumeCursor: legacyCursor,
        targetThreadId: ThreadId.make("fork"),
        turnId: TurnId.make("t3"),
        turnOrdinal: 3,
        isLatestTurn: true,
      }),
    ).toMatchObject({ resumeCursor: { resumeSessionAt: "uuid-last", forkSession: true } });
    expect(
      buildClaudeForkResumeCursor({
        sourceResumeCursor: legacyCursor,
        targetThreadId: ThreadId.make("fork"),
        turnId: TurnId.make("t1"),
        turnOrdinal: 1,
        isLatestTurn: false,
      }),
    ).toHaveProperty("issue");
  });

  it("refuses sources without a Claude session", () => {
    expect(
      buildClaudeForkResumeCursor({
        sourceResumeCursor: { threadId: "source" },
        targetThreadId: ThreadId.make("fork"),
        turnId: TurnId.make("t1"),
        turnOrdinal: 1,
        isLatestTurn: true,
      }),
    ).toEqual({ issue: "The source thread has no Claude session to fork." });
  });
});
