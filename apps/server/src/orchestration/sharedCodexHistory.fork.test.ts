// Fork: Shared Codex desktop backend (FORK_FEATURES.md).
import { expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import { sharedHistoryCommand } from "./sharedCodexHistory.ts";

it("preserves native order and UUIDv7 precision when the turn timestamp is rounded", () => {
  const milliseconds = Date.parse("2026-04-01T00:00:00.750Z");
  const hex = milliseconds.toString(16).padStart(12, "0");
  const turn = {
    id: `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-000000000000`,
    status: "completed",
    startedAt: Math.floor(milliseconds / 1000),
    items: [
      { id: "z-user", type: "userMessage", content: [{ type: "text", text: "Question" }] },
      { id: "a-answer", type: "agentMessage", text: "Answer" },
    ],
  };
  const command = sharedHistoryCommand(
    ThreadId.make("t3-task"),
    "native-task",
    turn,
    "2026-04-01T00:00:01.000Z",
  );
  expect(command.createdAt).toBe("2026-04-01T00:00:00.750Z");
  expect(
    [...command.messages]
      .sort((a, b) => a.messageId.localeCompare(b.messageId))
      .map((message) => message.text),
  ).toEqual(["Question", "Answer"]);
  expect(
    sharedHistoryCommand(ThreadId.make("t3-task"), "native-task", turn, "2026-04-02T00:00:00.000Z")
      .commandId,
  ).toBe(command.commandId);
});
