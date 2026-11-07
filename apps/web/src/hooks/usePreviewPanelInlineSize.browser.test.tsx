import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { resolvePreviewPanelWidth, usePreviewPanelInlineSize } from "./usePreviewPanelInlineSize";

const STORAGE_KEY = "test:preview-panel-width";
const CHAT_STORAGE_KEY = `${STORAGE_KEY}:chat-column`;

describe("resolvePreviewPanelWidth", () => {
  it.each([
    {
      name: "no chat width yet: the remembered panel width",
      chatWidth: null,
      rowWidth: 1200,
      expected: 540,
    },
    { name: "a wider row lands on the panel", chatWidth: 660, rowWidth: 1500, expected: 840 },
    { name: "a narrower row lands on the panel", chatWidth: 660, rowWidth: 1100, expected: 440 },
    {
      name: "the panel stops at its minimum, then the chat gives way",
      chatWidth: 660,
      rowWidth: 900,
      expected: 360,
    },
    { name: "the chat keeps its own minimum", chatWidth: 200, rowWidth: 1000, expected: 640 },
    {
      name: "too narrow for both: the panel keeps its minimum",
      chatWidth: 660,
      rowWidth: 600,
      expected: 360,
    },
  ])("$name", ({ chatWidth, rowWidth, expected }) => {
    expect(
      resolvePreviewPanelWidth({ rowWidth, chatWidth, panelWidth: 540, viewportWidth: 1600 }),
    ).toBe(expected);
  });
});

function Row({
  rowWidth,
  enabled = true,
  onGrowthStart,
}: {
  rowWidth: number;
  enabled?: boolean;
  onGrowthStart?: (settle: (addedWidth: number | null) => void) => void;
}) {
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const { width, handlers, observeRow, beginWindowGrowth } = usePreviewPanelInlineSize({
    enabled,
    container: row,
    widthStorageKey: STORAGE_KEY,
  });
  return (
    <div ref={setRow} style={{ display: "flex", width: rowWidth }}>
      <button style={{ flex: 1 }} onClick={() => onGrowthStart?.(beginWindowGrowth())} />
      <div
        ref={(host) => (host === null ? undefined : observeRow(host))}
        data-testid="panel"
        style={{ width }}
      >
        <div role="separator" style={{ width: 8, height: 40 }} {...handlers} />
        {width}
      </div>
    </div>
  );
}

async function withCleanStorage(run: () => Promise<void>) {
  const previous = [STORAGE_KEY, CHAT_STORAGE_KEY].map((key) => ({
    key,
    value: localStorage.getItem(key),
  }));
  for (const { key } of previous) localStorage.removeItem(key);
  try {
    await run();
  } finally {
    for (const { key, value } of previous) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
  }
}

describe("usePreviewPanelInlineSize", () => {
  it("keeps the chat width when the row resizes and lands the change on the panel", async () => {
    await withCleanStorage(async () => {
      // This hook only needs browser storage and React; no navigation is involved.
      await using screen = await render(<Row rowWidth={1200} />, { router: false });
      const panel = screen.getByTestId("panel");
      await expect.element(panel).toHaveTextContent("540");

      await screen.rerender(<Row rowWidth={1400} />);
      await expect.element(panel).toHaveTextContent("740");
      expect(localStorage.getItem(CHAT_STORAGE_KEY)).toBe("660");

      await screen.rerender(<Row rowWidth={1100} />);
      await expect.element(panel).toHaveTextContent("440");

      // The panel stops at its minimum and the chat gives way.
      await screen.rerender(<Row rowWidth={800} />);
      await expect.element(panel).toHaveTextContent("360");
      expect(localStorage.getItem(CHAT_STORAGE_KEY)).toBe("660");
    });
  });

  it("leaves the chat width unpinned while the panel is not beside the chat", async () => {
    await withCleanStorage(async () => {
      // This hook only needs browser storage and React; no navigation is involved.
      await using screen = await render(<Row rowWidth={1200} enabled={false} />, {
        router: false,
      });
      await screen.rerender(<Row rowWidth={1400} enabled={false} />);
      await expect.element(screen.getByTestId("panel")).toHaveTextContent("540");
      expect(localStorage.getItem(CHAT_STORAGE_KEY)).toBeNull();
    });
  });

  it.each([
    { name: "a full grow keeps the chat at its old width", added: 540, chat: "1000", panel: "540" },
    { name: "a zoomed window squeezes the chat instead", added: 0, chat: "460", panel: "540" },
    {
      name: "an already grown window keeps the saved chat width",
      added: null,
      chat: "600",
      panel: "400",
    },
  ])("desktop window growth: $name", async ({ added, chat, panel }) => {
    await withCleanStorage(async () => {
      localStorage.setItem(CHAT_STORAGE_KEY, "600");
      let settle: ((addedWidth: number | null) => void) | undefined;
      const onGrowthStart = (next: typeof settle) => (settle = next);
      // This hook only needs browser storage and React; no navigation is involved.
      await using screen = await render(<Row rowWidth={1000} onGrowthStart={onGrowthStart} />, {
        router: false,
      });
      await act(() => screen.container.querySelector("button")!.click());
      const grown = 1000 + (added ?? 0);
      await screen.rerender(<Row rowWidth={grown} onGrowthStart={onGrowthStart} />);
      await act(() => settle!(added));
      await expect.element(screen.getByTestId("panel")).toHaveTextContent(panel);
      expect(localStorage.getItem(CHAT_STORAGE_KEY)).toBe(chat);
    });
  });

  it("a divider drag sets the chat width, which a reload and a row resize keep", async () => {
    await withCleanStorage(async () => {
      // This hook only needs browser storage and React; no navigation is involved.
      await using screen = await render(<Row rowWidth={1200} />, { router: false });
      const handle = screen.container.querySelector<HTMLElement>('[role="separator"]')!;
      // Synthetic drag events have no active browser pointer to capture.
      using _capture = vi.spyOn(handle, "setPointerCapture").mockImplementation(() => {});
      const pointer = { bubbles: true, pointerId: 1, button: 0 };
      await act(() => {
        handle.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientX: 600 }));
        handle.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientX: 500 }));
      });
      await expect.element(screen.getByTestId("panel")).toHaveTextContent("640");
      expect(localStorage.getItem(CHAT_STORAGE_KEY)).toBe("560");
      expect(localStorage.getItem(STORAGE_KEY)).toBe("640");

      await screen.unmount();
      await using restored = await render(<Row rowWidth={1000} />, { router: false });
      await expect.element(restored.getByTestId("panel")).toHaveTextContent("440");
    });
  });
});
