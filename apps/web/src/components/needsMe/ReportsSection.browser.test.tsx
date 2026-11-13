import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

vi.mock(import("../ChatMarkdown"), () => ({
  default: ((props: { readonly text: string }) => <span>{props.text}</span>) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));

import { ReportsSection } from "./ReportsSection";

const environmentId = EnvironmentId.make("env-1");
const report = (id: string, night: string) => ({
  id,
  title: `Report ${id}`,
  summary: "Found it.",
  location: `/reports/${id}.md`,
  pinnedAt: `${night}T22:00:00.000Z`,
  night,
});

it("opens on the latest night and shows one earlier night per press", async () => {
  window.localStorage.clear();
  using _storage = { [Symbol.dispose]: () => window.localStorage.clear() };
  await using screen = await render(
    <ReportsSection
      environmentId={environmentId}
      hostRef={{ environmentId, threadId: ThreadId.make("thread-1") }}
      nowMs={new Date(2026, 10, 13, 8).getTime()}
      reports={[
        report("review-b", "2026-11-12"),
        report("review-a", "2026-11-12"),
        report("tue", "2026-11-10"),
        report("wed", "2026-11-11"),
      ]}
    />,
  );

  const lastNight = screen.getByRole("region", { name: /^Last night · / });
  await expect.element(lastNight.getByText("Report review-b")).toBeVisible();
  await expect.element(lastNight.getByText("Report review-a")).toBeVisible();
  await expect.element(screen.getByText("Report wed")).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Reports · 2" })).toBeVisible();

  const showEarlier = screen.getByRole("button", { name: "Show earlier" });
  await userEvent.click(showEarlier);
  await expect.element(screen.getByText("Report wed")).toBeVisible();
  await expect.element(screen.getByText("Report tue")).not.toBeInTheDocument();
  await userEvent.click(showEarlier);
  await expect.element(screen.getByText("Report tue")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Reports · 4" })).toBeVisible();
  await expect.element(showEarlier).not.toBeInTheDocument();
});
