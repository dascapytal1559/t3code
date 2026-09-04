// Fork: Fork a thread (FORK_FEATURES.md) — the OpenCode fork seed cursor.
import { describe, expect, it } from "vite-plus/test";

import { buildOpenCodeForkResumeCursor } from "./OpenCodeAdapter.ts";

describe("buildOpenCodeForkResumeCursor", () => {
  it("names the source session and the assistant ordinal to fork at", () => {
    expect(
      buildOpenCodeForkResumeCursor({
        sourceResumeCursor: { schemaVersion: 1, sessionId: "ses_source" },
        turnOrdinal: 3,
      }),
    ).toEqual({
      resumeCursor: { schemaVersion: 1, sessionId: "ses_source", forkAtAssistantOrdinal: 3 },
    });
  });

  it("keeps pointing at the original session when forking an unstarted fork", () => {
    expect(
      buildOpenCodeForkResumeCursor({
        sourceResumeCursor: {
          schemaVersion: 1,
          sessionId: "ses_source",
          forkAtAssistantOrdinal: 5,
        },
        turnOrdinal: 2,
      }),
    ).toEqual({
      resumeCursor: { schemaVersion: 1, sessionId: "ses_source", forkAtAssistantOrdinal: 2 },
    });
  });

  it("refuses sources without a session", () => {
    expect(buildOpenCodeForkResumeCursor({ sourceResumeCursor: null, turnOrdinal: 1 })).toEqual({
      issue: "The source thread has no OpenCode session to fork.",
    });
    expect(
      buildOpenCodeForkResumeCursor({
        sourceResumeCursor: { schemaVersion: 99, sessionId: "ses_source" },
        turnOrdinal: 1,
      }),
    ).toHaveProperty("issue");
  });
});
