import { INDEFINITE_SNOOZE_UNTIL, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { formatCrewReply, formatCrewThreadAction, type CrewThreadAction } from "./CrewReply.logic";

const thread = { id: ThreadId.make("thread:garden-shed"), title: "Garden shed paint" };

it("names the worker on the line FirstMate reads, between the header and the words", () => {
  expect(formatCrewReply({ thread, text: "  Go with green.\n\nGrey fades.  " })).toBe(
    "**Reply · Garden shed paint**\nkept-thread: thread:garden-shed\n\nGo with green.\n\nGrey fades.",
  );
});

it.each<[CrewThreadAction, string, string]>([
  [{ kind: "settled" }, "Settled", "settled"],
  [{ kind: "unsettled" }, "Un-settled", "unsettled"],
  [
    { kind: "snoozed", snoozedUntil: "2026-11-17T09:00:00.000+10:00" },
    "Snoozed",
    "snoozed until 2026-11-16T23:00:00Z",
  ],
  [{ kind: "snoozed", snoozedUntil: INDEFINITE_SNOOZE_UNTIL }, "Snoozed", "snoozed"],
  [{ kind: "unsnoozed" }, "Un-snoozed", "unsnoozed"],
])("tells FirstMate the captain's %j on the worker", (action, heading, line) => {
  expect(formatCrewThreadAction({ thread, action })).toBe(
    `**${heading} · Garden shed paint**\nkept-thread: thread:garden-shed\nthread-action: ${line}`,
  );
});
