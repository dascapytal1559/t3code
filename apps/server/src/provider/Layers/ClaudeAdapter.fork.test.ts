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
