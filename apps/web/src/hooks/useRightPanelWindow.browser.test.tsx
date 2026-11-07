import { type RefObject, useImperativeHandle, useRef, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { type PanelChatColumn, usePreviewPanelInlineSize } from "./usePreviewPanelInlineSize";
import { useRightPanelWindow } from "./useRightPanelWindow";

const STORAGE_KEY = "test:right-panel-window-width";
const CHAT_STORAGE_KEY = `${STORAGE_KEY}:chat-column`;

function Panel(props: { row: HTMLElement | null; chatColumn: RefObject<PanelChatColumn | null> }) {
  const { width, observeRow, keepChatColumn, keepPanelWidth } = usePreviewPanelInlineSize({
    container: props.row,
    widthStorageKey: STORAGE_KEY,
  });
  useImperativeHandle(props.chatColumn, () => ({ keepChatColumn, keepPanelWidth }), [
    keepChatColumn,
    keepPanelWidth,
  ]);
  return (
    <div
      ref={(host) => (host === null ? undefined : observeRow(host))}
      data-testid="panel"
      style={{ width, flexShrink: 0 }}
    />
  );
}

/** ChatView's shape: a row holding the chat column and the panel, inside the window. */
function Workspace({ open, windowWidth }: { open: boolean; windowWidth: number }) {
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const chatColumn = useRef<PanelChatColumn>(null);
  const { holdingOpen, holdingClose } = useRightPanelWindow({
    open,
    row,
    inline: true,
    scopeKey: "thread",
    widthStorageKey: STORAGE_KEY,
    chatColumn,
  });
  return (
    <div style={{ width: windowWidth, overflow: "clip" }}>
      <div data-testid="titlebar" data-open={(open || holdingClose) && !holdingOpen} />
      <div ref={setRow} data-testid="row" style={{ display: "flex", height: 10 }}>
        <div data-testid="chat" style={{ flex: 1, minWidth: 0 }} />
        {open || holdingClose ? <Panel row={row} chatColumn={chatColumn} /> : null}
      </div>
    </div>
  );
}

/** A desktop window whose resizes the test answers and applies by hand. */
function fakeDesktopWindow(initialWidth: number) {
  const requests: Array<{
    open: boolean;
    width: number;
    answer: (changed: number | null) => void;
  }> = [];
  let width = initialWidth;
  const previousBridge = window.desktopBridge;
  window.desktopBridge = {
    setRightPanelOpen: (open: boolean, panelWidth: number) =>
      new Promise<number | null>((answer) => {
        requests.push({ open, width: panelWidth, answer });
      }),
  } as unknown as NonNullable<typeof window.desktopBridge>;
  const innerWidth = vi.spyOn(window, "innerWidth", "get").mockImplementation(() => width);
  return {
    requests,
    /** The viewport catches up with the native window and fires resize. */
    resize(next: number) {
      width = next;
      window.dispatchEvent(new Event("resize"));
    },
    [Symbol.dispose]() {
      innerWidth.mockRestore();
      if (previousBridge === undefined) delete window.desktopBridge;
      else window.desktopBridge = previousBridge;
    },
  };
}

function widthOf(element: Element): number {
  return element.getBoundingClientRect().width;
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

describe("useRightPanelWindow", () => {
  it("keeps the chat column still while the window grows for the panel and shrinks after it", async () => {
    await withCleanStorage(async () => {
      localStorage.setItem(CHAT_STORAGE_KEY, "600");
      using desktop = fakeDesktopWindow(1000);
      // The hook only needs React and the desktop bridge; no navigation is involved.
      await using screen = await render(<Workspace open={false} windowWidth={1000} />, {
        router: false,
      });
      const chat = screen.getByTestId("chat").element();
      const row = screen.getByTestId("row").element() as HTMLElement;
      const titlebar = screen.getByTestId("titlebar").element();

      // Opening lays the panel out past the window's edge before the window grows.
      await screen.rerender(<Workspace open windowWidth={1000} />);
      expect(desktop.requests.map(({ open, width }) => ({ open, width }))).toEqual([
        { open: true, width: 540 },
      ]);
      expect(widthOf(chat)).toBe(1000);
      expect(widthOf(screen.getByTestId("panel").element())).toBe(540);
      await act(() => desktop.requests[0]!.answer(540));
      expect(row.style.width).toBe("1540px");
      // The title bar sits at the window's edge, so it changes only once the window has.
      expect(titlebar.getAttribute("data-open")).toBe("false");

      await screen.rerender(<Workspace open windowWidth={1540} />);
      await act(() => desktop.resize(1540));
      expect(row.style.width).toBe("");
      expect(titlebar.getAttribute("data-open")).toBe("true");
      expect(widthOf(chat)).toBe(1000);
      expect(localStorage.getItem(CHAT_STORAGE_KEY)).toBe("1000");

      // Closing keeps the panel until the window has shrunk, even before the window answers.
      await screen.rerender(<Workspace open={false} windowWidth={1540} />);
      expect(desktop.requests[1]).toMatchObject({ open: false });
      await expect.element(screen.getByTestId("panel")).toBeInTheDocument();
      expect(widthOf(chat)).toBe(1000);
      expect(titlebar.getAttribute("data-open")).toBe("true");

      await screen.rerender(<Workspace open={false} windowWidth={1000} />);
      expect(widthOf(chat)).toBe(1000);
      await act(() => desktop.resize(1000));
      await expect.element(screen.getByTestId("panel")).not.toBeInTheDocument();
      expect(titlebar.getAttribute("data-open")).toBe("false");
      expect(row.style.width).toBe("");
      expect(widthOf(chat)).toBe(1000);
      await act(() => desktop.requests[1]!.answer(540));
      expect(row.style.width).toBe("");
    });
  });

  it("a window resize while open goes to the panel and leaves with it", async () => {
    await withCleanStorage(async () => {
      using desktop = fakeDesktopWindow(1000);
      // The hook only needs React and the desktop bridge; no navigation is involved.
      await using screen = await render(<Workspace open={false} windowWidth={1000} />, {
        router: false,
      });
      const chat = screen.getByTestId("chat").element();
      await screen.rerender(<Workspace open windowWidth={1000} />);
      await screen.rerender(<Workspace open windowWidth={1540} />);
      await act(() => desktop.resize(1540));
      expect(widthOf(chat)).toBe(1000);

      await screen.rerender(<Workspace open windowWidth={1740} />);
      await vi.waitFor(() => expect(widthOf(screen.getByTestId("panel").element())).toBe(740));
      expect(widthOf(chat)).toBe(1000);
      await screen.rerender(<Workspace open={false} windowWidth={1740} />);
      expect(desktop.requests[1]).toMatchObject({ open: false, width: 740 });
      await screen.rerender(<Workspace open={false} windowWidth={1000} />);
      await act(() => desktop.resize(1000));
      expect(widthOf(chat)).toBe(1000);

      // Opening again grows by the panel's last width.
      await screen.rerender(<Workspace open windowWidth={1000} />);
      expect(desktop.requests[2]).toMatchObject({ open: true, width: 740 });
    });
  });

  it("gives the chat's width to the panel in one step when the window cannot grow", async () => {
    await withCleanStorage(async () => {
      using desktop = fakeDesktopWindow(1000);
      // The hook only needs React and the desktop bridge; no navigation is involved.
      await using screen = await render(<Workspace open={false} windowWidth={1000} />, {
        router: false,
      });
      await screen.rerender(<Workspace open windowWidth={1000} />);
      expect(widthOf(screen.getByTestId("chat").element())).toBe(1000);
      await act(() => desktop.requests[0]!.answer(0));
      expect(widthOf(screen.getByTestId("chat").element())).toBe(460);
      expect(localStorage.getItem(CHAT_STORAGE_KEY)).toBe("460");

      // A close that shrinks nothing does not wait for a resize.
      await screen.rerender(<Workspace open={false} windowWidth={1000} />);
      await act(() => desktop.requests[1]!.answer(null));
      await expect.element(screen.getByTestId("panel")).not.toBeInTheDocument();
    });
  });

  it("a view replacing another with the panel open takes over the grown window", async () => {
    await withCleanStorage(async () => {
      using desktop = fakeDesktopWindow(1000);
      // The hook only needs React and the desktop bridge; no navigation is involved.
      await using screen = await render(<Workspace key="a" open windowWidth={1000} />, {
        router: false,
      });
      await act(() => desktop.requests[0]!.answer(540));
      await screen.rerender(<Workspace key="b" open windowWidth={1000} />);
      await act(() => Promise.resolve());
      expect(desktop.requests.map(({ open }) => open)).toEqual([true]);

      await screen.unmount();
      await act(() => Promise.resolve());
      expect(desktop.requests.map(({ open }) => open)).toEqual([true, false]);
    });
  });

  it("keeps the saved chat width when a reload finds the window already grown", async () => {
    await withCleanStorage(async () => {
      localStorage.setItem(CHAT_STORAGE_KEY, "600");
      using desktop = fakeDesktopWindow(1000);
      // The hook only needs React and the desktop bridge; no navigation is involved.
      await using screen = await render(<Workspace open windowWidth={1000} />, {
        router: false,
      });
      expect(screen.getByTestId("row").element().getAttribute("style")).not.toContain("width");
      await act(() => desktop.requests[0]!.answer(null));
      expect(widthOf(screen.getByTestId("chat").element())).toBe(600);
      expect(localStorage.getItem(CHAT_STORAGE_KEY)).toBe("600");
    });
  });
});
