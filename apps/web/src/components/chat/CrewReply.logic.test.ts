import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { formatCrewReply } from "./CrewReply.logic";

it("names the worker on the line FirstMate reads, between the header and the words", () => {
  expect(
    formatCrewReply({
      thread: { id: ThreadId.make("thread:garden-shed"), title: "Garden shed paint" },
      text: "  Go with green.\n\nGrey fades.  ",
    }),
  ).toBe(
    "**Reply · Garden shed paint**\nkept-thread: thread:garden-shed\n\nGo with green.\n\nGrey fades.",
  );
});
