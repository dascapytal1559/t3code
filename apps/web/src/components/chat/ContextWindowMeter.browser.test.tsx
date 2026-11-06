import { OrchestrationV2ProviderTurnTokenUsage } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { deriveLatestContextWindowSnapshot } from "~/lib/contextWindow";
import { render } from "../../../test/render";
import { ContextWindowMeter } from "./ContextWindowMeter";

const usage = deriveLatestContextWindowSnapshot(
  [],
  Schema.decodeSync(OrchestrationV2ProviderTurnTokenUsage)({
    usedTokens: 393_000,
    maxTokens: 1_000_000,
    updatedAt: "2026-11-01T00:00:00.000Z",
  }),
)!;

const openBox = () => userEvent.click(page.getByRole("button", { name: /^Context window/ }));

it("leads with Refresh FirstMate context on the coordinator and keeps compact as a link", async () => {
  const onCompact = vi.fn();
  const onRefreshContext = vi.fn();
  await using screen = await render(
    <ContextWindowMeter usage={usage} onCompact={onCompact} onRefreshContext={onRefreshContext} />,
  );
  await openBox();

  const refresh = page.getByRole("button", { name: "Refresh FirstMate context" });
  const compact = page.getByRole("button", { name: "Compact context" });
  await expect.element(refresh).toHaveClass("bg-primary");
  await expect.element(compact).not.toHaveClass("bg-primary");
  await expect.element(compact).not.toHaveClass("border-input");

  await userEvent.click(refresh);
  expect(onRefreshContext).toHaveBeenCalledTimes(1);
  await userEvent.click(compact);
  expect(onCompact).toHaveBeenCalledTimes(1);

  await screen.rerender(
    <ContextWindowMeter
      usage={usage}
      onCompact={onCompact}
      compactDisabled
      compactDisabledReason="Compacting is unavailable right now"
      onRefreshContext={onRefreshContext}
      refreshContextDisabled
    />,
  );
  await expect.element(refresh).toBeDisabled();
  await expect.element(compact).toBeDisabled();
  await expect.element(page.getByText("Refresh context once the turn ends")).toBeVisible();
  await expect.element(page.getByText("Compacting is unavailable right now")).toBeVisible();
});

it("keeps upstream's single Compact context button on other threads", async () => {
  const onCompact = vi.fn();
  await using _screen = await render(<ContextWindowMeter usage={usage} onCompact={onCompact} />);
  await openBox();

  const compact = page.getByRole("button", { name: "Compact context" });
  await expect.element(compact).toHaveClass("border-input");
  await expect.element(page.getByRole("button", { name: /Refresh/ })).not.toBeInTheDocument();
  await userEvent.click(compact);
  expect(onCompact).toHaveBeenCalledTimes(1);
});
