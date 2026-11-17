import { deriveLatestContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ContextWindowMeter } from "./ContextWindowMeter";

const usage = deriveLatestContextWindowSnapshot([], {
  usedTokens: 250_000,
  maxTokens: 1_000_000,
  updatedAt: "2026-11-18T12:00:00.000Z",
})!;

const openPopover = async () => {
  await userEvent.click(page.getByRole("button", { name: "Context window 25% used" }));
};

it("on FirstMate's main thread, leads with Start a new session and keeps Compact context as a link", async () => {
  const onStartNewSession = vi.fn();
  const onCompact = vi.fn();
  await using _screen = await render(
    <ContextWindowMeter
      usage={usage}
      onCompact={onCompact}
      onStartNewSession={onStartNewSession}
      startNewSessionDisabledReason={null}
    />,
    { router: false }, // a lone component, no routes involved
  );
  await openPopover();
  const start = page.getByRole("button", { name: "Start a new session" });
  const compact = page.getByRole("button", { name: "Compact context" });
  // The filled primary button leads; compaction is a plain link below it.
  await expect.element(start).toHaveClass("bg-primary");
  await expect.element(compact).toHaveClass("underline-offset-4");
  expect(
    start.element().compareDocumentPosition(compact.element()) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await userEvent.click(start);
  expect(onStartNewSession).toHaveBeenCalledOnce();
  expect(onCompact).not.toHaveBeenCalled();
});

it("disables Start a new session with its reason while FirstMate is busy", async () => {
  const onStartNewSession = vi.fn();
  await using _screen = await render(
    <ContextWindowMeter
      usage={usage}
      onCompact={() => {}}
      compactDisabled
      onStartNewSession={onStartNewSession}
      startNewSessionDisabledReason="FirstMate is busy. Start a new session once its turn ends."
    />,
    { router: false }, // a lone component, no routes involved
  );
  await openPopover();
  await expect.element(page.getByRole("button", { name: "Start a new session" })).toBeDisabled();
  await expect
    .element(page.getByText("FirstMate is busy. Start a new session once its turn ends."))
    .toBeVisible();
});

it("on any other thread, keeps Compact context as the one outlined action", async () => {
  await using _screen = await render(<ContextWindowMeter usage={usage} onCompact={() => {}} />, {
    router: false, // a lone component, no routes involved
  });
  await openPopover();
  await expect
    .element(page.getByRole("button", { name: "Compact context" }))
    .toHaveClass("border-input");
  await expect
    .element(page.getByRole("button", { name: "Start a new session" }))
    .not.toBeInTheDocument();
});
