import type {
  RightPanelWindowInterruption,
  RightPanelWindowRequest,
  RightPanelWindowResult,
} from "@t3tools/contracts";
import { type Ref, useImperativeHandle, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";
import { type PanelChatColumn, usePreviewPanelInlineSize } from "./usePreviewPanelInlineSize";
import { useRightPanelWindow } from "./useRightPanelWindow";

const STORAGE_KEY = "test:right-panel-window-width";
const CHAT_STORAGE_KEY = `${STORAGE_KEY}:chat-column`;

function Panel(props: { row: HTMLElement | null; chatColumn: Ref<PanelChatColumn> }) {
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
function Workspace({
  open,
  windowWidth,
  scopeKey = "thread",
  sheet = false,
}: {
  open: boolean;
  windowWidth: number;
  scopeKey?: string;
  /** The narrow layout, which shows the panel as a sheet over the chat. */
  sheet?: boolean;
}) {
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const { holdingOpen, holdingClose, chatColumnRef } = useRightPanelWindow({
    open,
    row,
    maximized: false,
    sheet,
    scopeKey,
    widthStorageKey: STORAGE_KEY,
  });
  const present = open || holdingClose;
  const asSheet = sheet && !holdingOpen && !holdingClose;
  return (
    <div style={{ width: windowWidth, overflow: "clip", position: "relative" }}>
      <div data-testid="titlebar" data-open={present && !holdingOpen} />
      <div ref={setRow} data-testid="row" style={{ display: "flex", height: 10 }}>
        <div data-testid="chat" style={{ flex: 1, minWidth: 0 }} />
        {present && !asSheet ? <Panel row={row} chatColumn={chatColumnRef} /> : null}
      </div>
      {present && asSheet ? <div data-testid="sheet" style={{ position: "absolute" }} /> : null}
    </div>
  );
}

type Answer = number | Exclude<RightPanelWindowResult["status"], "resized">;

/** A desktop window whose resizes the test answers and applies by hand. */
function fakeDesktopWindow(initialWidth: number) {
  const requests: Array<RightPanelWindowRequest & { answer: (answer: Answer) => void }> = [];
  const interruptListeners = new Set<(interruption: RightPanelWindowInterruption) => void>();
  let width = initialWidth;
  const previousBridge = window.desktopBridge;
  window.desktopBridge = {
    setRightPanelOpen: (request: RightPanelWindowRequest) =>
      new Promise<RightPanelWindowResult>((resolve) => {
        requests.push({
          ...request,
          // A number is the viewport width the window resized to.
          answer: (answer) =>
            resolve(
              typeof answer === "number"
                ? { requestId: request.requestId, status: "resized", contentWidth: answer }
                : { requestId: request.requestId, status: answer },
            ),
        });
      }),
    onRightPanelWindowInterrupted: (
      listener: (interruption: RightPanelWindowInterruption) => void,
    ) => {
      interruptListeners.add(listener);
      return () => interruptListeners.delete(listener);
    },
  } as unknown as NonNullable<typeof window.desktopBridge>;
  const innerWidth = vi.spyOn(window, "innerWidth", "get").mockImplementation(() => width);
  return {
    requests,
    /** The viewport catches up with the native window and fires resize. */
    resize(next: number) {
      width = next;
      window.dispatchEvent(new Event("resize"));
    },
    /** Something other than the request resized the native window to `contentWidth`. */
    interrupt(requestId: number, contentWidth: number) {
      for (const listener of interruptListeners) listener({ requestId, contentWidth });
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
      using _timers = fakeTimers();
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
      await act(() => desktop.requests[0]!.answer(1540));
      // However late the viewport follows, nothing gives up waiting for it.
      await act(() => vi.advanceTimersByTime(5_000));
      expect(row.style.width).toBe("1540px");
      // The title bar sits at the window's edge, so it changes only once the window has.
      expect(titlebar.getAttribute("data-open")).toBe("false");

      // A width on the way to the target keeps the row held.
      await screen.rerender(<Workspace open windowWidth={1200} />);
      await act(() => desktop.resize(1200));
      expect(row.style.width).toBe("1540px");
      expect(widthOf(chat)).toBe(1000);
      expect(titlebar.getAttribute("data-open")).toBe("false");

      await screen.rerender(<Workspace open windowWidth={1540} />);
      await act(() => desktop.resize(1540));
      expect(row.style.width).toBe("");
      expect(titlebar.getAttribute("data-open")).toBe("true");
      expect(widthOf(chat)).toBe(1000);
      expect(localStorage.getItem(CHAT_STORAGE_KEY)).toBe("1000");

      // Closing keeps the panel until the window has shrunk.
      await screen.rerender(<Workspace open={false} windowWidth={1540} />);
      expect(desktop.requests[1]).toMatchObject({ open: false, width: 540 });
      await expect.element(screen.getByTestId("panel")).toBeInTheDocument();
      expect(widthOf(chat)).toBe(1000);
      expect(titlebar.getAttribute("data-open")).toBe("true");

      // The viewport can shrink before the answer arrives; the answer then settles at once.
      await screen.rerender(<Workspace open={false} windowWidth={1000} />);
      await act(() => desktop.resize(1000));
      await expect.element(screen.getByTestId("panel")).toBeInTheDocument();
      expect(widthOf(chat)).toBe(1000);
      await act(() => desktop.requests[1]!.answer(1000));
      await expect.element(screen.getByTestId("panel")).not.toBeInTheDocument();
      expect(titlebar.getAttribute("data-open")).toBe("false");
      expect(row.style.width).toBe("");
      expect(widthOf(chat)).toBe(1000);
    });
  });

  it("opens from the narrow layout inline past the window's edge, not as a sheet inside it", async () => {
    await withCleanStorage(async () => {
      using desktop = fakeDesktopWindow(900);
      // The hook only needs React and the desktop bridge; no navigation is involved.
      await using screen = await render(<Workspace open={false} windowWidth={900} sheet />, {
        router: false,
      });
      const chat = screen.getByTestId("chat").element();
      const row = screen.getByTestId("row").element() as HTMLElement;

      await screen.rerender(<Workspace open windowWidth={900} sheet />);
      await expect.element(screen.getByTestId("sheet")).not.toBeInTheDocument();
      expect(row.style.width).toBe("1440px");
      expect(widthOf(chat)).toBe(900);
      expect(widthOf(screen.getByTestId("panel").element())).toBe(540);
      await act(() => desktop.requests[0]!.answer(1440));
      await act(() => desktop.resize(1100));
      expect(row.style.width).toBe("1440px");

      // The wider window leaves the narrow layout.
      await screen.rerender(<Workspace open windowWidth={1440} />);
      await act(() => desktop.resize(1440));
      expect(row.style.width).toBe("");
      expect(widthOf(chat)).toBe(900);
      expect(widthOf(screen.getByTestId("panel").element())).toBe(540);
    });
  });

  it("shows the sheet when a narrow window cannot grow, and closes it as a sheet", async () => {
    await withCleanStorage(async () => {
      using desktop = fakeDesktopWindow(900);
      // The hook only needs React and the desktop bridge; no navigation is involved.
      await using screen = await render(<Workspace open={false} windowWidth={900} sheet />, {
        router: false,
      });
      await screen.rerender(<Workspace open windowWidth={900} sheet />);
      await act(() => desktop.requests[0]!.answer("noRoom"));
      await expect.element(screen.getByTestId("sheet")).toBeInTheDocument();
      await expect.element(screen.getByTestId("panel")).not.toBeInTheDocument();
      expect(screen.getByTestId("row").element().getAttribute("style")).not.toContain("width");
      expect(widthOf(screen.getByTestId("chat").element())).toBe(900);

      await screen.rerender(<Workspace open={false} windowWidth={900} sheet />);
      await expect.element(screen.getByTestId("sheet")).not.toBeInTheDocument();
      await expect.element(screen.getByTestId("panel")).not.toBeInTheDocument();
      expect(desktop.requests[1]).toMatchObject({ open: false });
    });
  });

  it("a toggle back before the window has resized keeps the chat column where it is", async () => {
    await withCleanStorage(async () => {
      using desktop = fakeDesktopWindow(1000);
      // The hook only needs React and the desktop bridge; no navigation is involved.
      await using screen = await render(<Workspace open={false} windowWidth={1000} />, {
        router: false,
      });
      const chat = screen.getByTestId("chat").element();
      const row = screen.getByTestId("row").element() as HTMLElement;
      await screen.rerender(<Workspace open windowWidth={1000} />);
      await screen.rerender(<Workspace open={false} windowWidth={1000} />);
      expect(desktop.requests.map(({ open, width }) => ({ open, width }))).toEqual([
        { open: true, width: 540 },
        { open: false, width: 540 },
      ]);
      // The window still grows first, so the panel stays laid out past its edge.
      await expect.element(screen.getByTestId("panel")).toBeInTheDocument();
      expect(row.style.width).toBe("1540px");

      // The superseded request's target no longer ends the hold.
      await act(() => desktop.requests[0]!.answer(1540));
      await screen.rerender(<Workspace open={false} windowWidth={1540} />);
      await act(() => desktop.resize(1540));
      expect(row.style.width).toBe("1540px");
      expect(widthOf(chat)).toBe(1000);

      await act(() => desktop.requests[1]!.answer(1000));
      await screen.rerender(<Workspace open={false} windowWidth={1000} />);
      await act(() => desktop.resize(1000));
      await expect.element(screen.getByTestId("panel")).not.toBeInTheDocument();
      expect(row.style.width).toBe("");
      expect(widthOf(chat)).toBe(1000);
    });
  });

  it("lets go of the row when something else resizes the window or the thread changes", async () => {
    await withCleanStorage(async () => {
      using desktop = fakeDesktopWindow(1000);
      // The hook only needs React and the desktop bridge; no navigation is involved.
      await using screen = await render(<Workspace open={false} windowWidth={1000} />, {
        router: false,
      });
      const row = screen.getByTestId("row").element() as HTMLElement;
      const titlebar = screen.getByTestId("titlebar").element();
      await screen.rerender(<Workspace open windowWidth={1000} />);
      await act(() => desktop.requests[0]!.answer(1540));
      // A hand resize mid-request means the target never comes; the viewport has yet to follow.
      await act(() => desktop.interrupt(desktop.requests[0]!.requestId, 1300));
      expect(row.style.width).toBe("1540px");
      await screen.rerender(<Workspace open windowWidth={1300} />);
      await act(() => desktop.resize(1300));
      expect(row.style.width).toBe("");
      expect(titlebar.getAttribute("data-open")).toBe("true");
      // Like any hand resize while open, it went to the panel.
      await vi.waitFor(() => expect(widthOf(screen.getByTestId("chat").element())).toBe(940));

      await screen.rerender(<Workspace open={false} windowWidth={1300} />);
      await expect.element(screen.getByTestId("panel")).toBeInTheDocument();
      expect(row.style.width).toBe("1300px");
      await screen.rerender(<Workspace open={false} windowWidth={1300} scopeKey="other" />);
      await expect.element(screen.getByTestId("panel")).not.toBeInTheDocument();
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
      await act(() => desktop.requests[0]!.answer(1540));
      await screen.rerender(<Workspace open windowWidth={1540} />);
      await act(() => desktop.resize(1540));
      expect(widthOf(chat)).toBe(1000);

      await screen.rerender(<Workspace open windowWidth={1740} />);
      await vi.waitFor(() => expect(widthOf(screen.getByTestId("panel").element())).toBe(740));
      expect(widthOf(chat)).toBe(1000);
      await screen.rerender(<Workspace open={false} windowWidth={1740} />);
      expect(desktop.requests[1]).toMatchObject({ open: false, width: 740 });
      await act(() => desktop.requests[1]!.answer(1000));
      await screen.rerender(<Workspace open={false} windowWidth={1000} />);
      await act(() => desktop.resize(1000));
      expect(widthOf(chat)).toBe(1000);

      // Opening again grows by the panel's last width.
      await screen.rerender(<Workspace open windowWidth={1000} />);
      expect(desktop.requests[2]).toMatchObject({ open: true, width: 740 });
      await act(() => desktop.requests[2]!.answer(1740));
      await screen.rerender(<Workspace open windowWidth={1740} />);
      await act(() => desktop.resize(1740));

      // A thread without the panel unmounts it at once, and the window still sheds its width.
      await screen.rerender(<Workspace open windowWidth={1940} />);
      await vi.waitFor(() => expect(widthOf(screen.getByTestId("panel").element())).toBe(940));
      await screen.rerender(<Workspace open={false} windowWidth={1940} scopeKey="other" />);
      await expect.element(screen.getByTestId("panel")).not.toBeInTheDocument();
      expect(desktop.requests[3]).toMatchObject({ open: false, width: 940 });
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
      await act(() => desktop.requests[0]!.answer("noRoom"));
      expect(widthOf(screen.getByTestId("chat").element())).toBe(460);
      expect(localStorage.getItem(CHAT_STORAGE_KEY)).toBe("460");

      // A close that shrinks nothing does not wait for a resize.
      await screen.rerender(<Workspace open={false} windowWidth={1000} />);
      await act(() => desktop.requests[1]!.answer("unchanged"));
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
      await act(() => desktop.requests[0]!.answer(1540));
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
      await act(() => desktop.requests[0]!.answer("unchanged"));
      expect(widthOf(screen.getByTestId("chat").element())).toBe(600);
      expect(localStorage.getItem(CHAT_STORAGE_KEY)).toBe("600");
    });
  });
});
