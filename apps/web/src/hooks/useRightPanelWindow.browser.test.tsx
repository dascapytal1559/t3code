import type { RightPanelWindowRequest, RightPanelWindowResult } from "@t3tools/contracts";
import { type Ref, useImperativeHandle, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { type PanelWidthHandle, usePreviewPanelInlineSize } from "./usePreviewPanelInlineSize";
import { useRightPanelWindow } from "./useRightPanelWindow";

const STORAGE_KEY = "test:right-panel-window-width";
const CHAT_STORAGE_KEY = `${STORAGE_KEY}:chat-column`;

function Panel(props: { row: HTMLElement | null; panelWidth: Ref<PanelWidthHandle> }) {
  const { width, observeRow, keepPanelWidth } = usePreviewPanelInlineSize({
    container: props.row,
    widthStorageKey: STORAGE_KEY,
  });
  useImperativeHandle(props.panelWidth, () => ({ keepPanelWidth }), [keepPanelWidth]);
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
  const { shown, panelWidthRef } = useRightPanelWindow({
    open,
    row,
    scopeKey,
    widthStorageKey: STORAGE_KEY,
  });
  return (
    <div style={{ width: windowWidth, overflow: "clip", position: "relative" }}>
      <div ref={setRow} data-testid="row" style={{ display: "flex", height: 10 }}>
        <div data-testid="chat" style={{ flex: 1, minWidth: 0 }} />
        {shown && !sheet ? <Panel row={row} panelWidth={panelWidthRef} /> : null}
      </div>
      {shown && sheet ? <div data-testid="sheet" style={{ position: "absolute" }} /> : null}
    </div>
  );
}

/** A desktop window whose requests the test answers, and whose viewport it resizes, by hand. */
function fakeDesktopWindow(initialWidth: number) {
  const requests: Array<
    RightPanelWindowRequest & { answer: (result: RightPanelWindowResult) => void }
  > = [];
  let width = initialWidth;
  const previousBridge = window.desktopBridge;
  window.desktopBridge = {
    setRightPanelOpen: (request: RightPanelWindowRequest) =>
      new Promise<RightPanelWindowResult>((resolve) => {
        requests.push({ ...request, answer: resolve });
      }),
  } as unknown as NonNullable<typeof window.desktopBridge>;
  const innerWidth = vi.spyOn(window, "innerWidth", "get").mockImplementation(() => width);
  return {
    requests,
    /** The page's viewport takes a new width and fires resize. */
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
  it("lays the panel out only in the resize that widens the viewport, and takes it out in the one that narrows it", async () => {
    await withCleanStorage(async () => {
      // A stale saved chat width must not move the chat when the panel opens.
      localStorage.setItem(CHAT_STORAGE_KEY, "600");
      using desktop = fakeDesktopWindow(1000);
      // The hook only needs React and the desktop bridge; no navigation is involved.
      await using screen = await render(<Workspace open={false} windowWidth={1000} />, {
        router: false,
      });
      const chat = screen.getByTestId("chat").element();

      // Opening asks the window and leaves the layout alone: nothing is drawn in the old window.
      await screen.rerender(<Workspace open windowWidth={1000} />);
      expect(desktop.requests.map(({ open, width }) => ({ open, width }))).toEqual([
        { open: true, width: 540 },
      ]);
      await expect.element(screen.getByTestId("panel")).not.toBeInTheDocument();
      expect(widthOf(chat)).toBe(1000);

      // The page is sized ahead of the window, and the panel joins the layout in that resize.
      await screen.rerender(<Workspace open windowWidth={1540} />);
      await act(() => desktop.resize(1540));
      expect(widthOf(screen.getByTestId("panel").element())).toBe(540);
      expect(widthOf(chat)).toBe(1000);
      expect(localStorage.getItem(CHAT_STORAGE_KEY)).toBe("1000");
      await act(() => desktop.requests[0]!.answer("resized"));
      expect(widthOf(chat)).toBe(1000);

      // Closing keeps the panel until the viewport has narrowed.
      await screen.rerender(<Workspace open={false} windowWidth={1540} />);
      expect(desktop.requests[1]).toMatchObject({ open: false, width: 540 });
      await expect.element(screen.getByTestId("panel")).toBeInTheDocument();
      expect(widthOf(chat)).toBe(1000);
      await screen.rerender(<Workspace open={false} windowWidth={1000} />);
      await act(() => desktop.resize(1000));
      await expect.element(screen.getByTestId("panel")).not.toBeInTheDocument();
      expect(widthOf(chat)).toBe(1000);
      await act(() => desktop.requests[1]!.answer("resized"));
      expect(widthOf(chat)).toBe(1000);
    });
  });

  it("opens a narrow window inline once it has grown, and as a sheet only when it cannot grow", async () => {
    await withCleanStorage(async () => {
      using desktop = fakeDesktopWindow(900);
      // The hook only needs React and the desktop bridge; no navigation is involved.
      await using screen = await render(<Workspace open={false} windowWidth={900} sheet />, {
        router: false,
      });
      const chat = screen.getByTestId("chat").element();

      await screen.rerender(<Workspace open windowWidth={900} sheet />);
      await expect.element(screen.getByTestId("sheet")).not.toBeInTheDocument();
      // The wider viewport leaves the narrow layout.
      await screen.rerender(<Workspace open windowWidth={1440} />);
      await act(() => desktop.resize(1440));
      await expect.element(screen.getByTestId("sheet")).not.toBeInTheDocument();
      expect(widthOf(screen.getByTestId("panel").element())).toBe(540);
      expect(widthOf(chat)).toBe(900);
      await act(() => desktop.requests[0]!.answer("resized"));

      await screen.rerender(<Workspace open={false} windowWidth={1440} />);
      await screen.rerender(<Workspace open={false} windowWidth={900} sheet />);
      await act(() => desktop.resize(900));
      await act(() => desktop.requests[1]!.answer("resized"));
      await expect.element(screen.getByTestId("panel")).not.toBeInTheDocument();

      // A window that cannot grow shows the sheet, and closes it without waiting for a resize.
      await screen.rerender(<Workspace open windowWidth={900} sheet />);
      await act(() => desktop.requests[2]!.answer("noRoom"));
      await expect.element(screen.getByTestId("sheet")).toBeInTheDocument();
      expect(widthOf(chat)).toBe(900);
      await screen.rerender(<Workspace open={false} windowWidth={900} sheet />);
      await act(() => desktop.requests[3]!.answer("unchanged"));
      await expect.element(screen.getByTestId("sheet")).not.toBeInTheDocument();
    });
  });

  it("a toggle back before the window has resized never moves the chat", async () => {
    await withCleanStorage(async () => {
      using desktop = fakeDesktopWindow(1000);
      // The hook only needs React and the desktop bridge; no navigation is involved.
      await using screen = await render(<Workspace open={false} windowWidth={1000} />, {
        router: false,
      });
      const chat = screen.getByTestId("chat").element();
      await screen.rerender(<Workspace open windowWidth={1000} />);
      await screen.rerender(<Workspace open={false} windowWidth={1000} />);
      expect(desktop.requests.map(({ open }) => open)).toEqual([true, false]);
      await expect.element(screen.getByTestId("panel")).not.toBeInTheDocument();

      // The page was already sized ahead: the panel follows the viewport out and back.
      await screen.rerender(<Workspace open={false} windowWidth={1540} />);
      await act(() => desktop.resize(1540));
      await expect.element(screen.getByTestId("panel")).toBeInTheDocument();
      expect(widthOf(chat)).toBe(1000);
      // The overtaken request's answer settles nothing.
      await act(() => desktop.requests[0]!.answer("unchanged"));
      await expect.element(screen.getByTestId("panel")).toBeInTheDocument();
      await screen.rerender(<Workspace open={false} windowWidth={1000} />);
      await act(() => desktop.resize(1000));
      await expect.element(screen.getByTestId("panel")).not.toBeInTheDocument();
      expect(widthOf(chat)).toBe(1000);
      await act(() => desktop.requests[1]!.answer("resized"));
      await expect.element(screen.getByTestId("panel")).not.toBeInTheDocument();
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
      await act(() => desktop.requests[0]!.answer("resized"));
      expect(widthOf(chat)).toBe(1000);

      // A hand resize once the request is answered is the panel's, not a reason to hide it.
      await screen.rerender(<Workspace open windowWidth={1740} />);
      await act(() => desktop.resize(1740));
      await vi.waitFor(() => expect(widthOf(screen.getByTestId("panel").element())).toBe(740));
      expect(widthOf(chat)).toBe(1000);
      await screen.rerender(<Workspace open windowWidth={1640} />);
      await act(() => desktop.resize(1640));
      await vi.waitFor(() => expect(widthOf(screen.getByTestId("panel").element())).toBe(640));
      await screen.rerender(<Workspace open={false} windowWidth={1640} />);
      expect(desktop.requests[1]).toMatchObject({ open: false, width: 640 });
      await screen.rerender(<Workspace open={false} windowWidth={1000} />);
      await act(() => desktop.resize(1000));
      await act(() => desktop.requests[1]!.answer("resized"));
      expect(widthOf(chat)).toBe(1000);

      // Opening again grows by the panel's last width.
      await screen.rerender(<Workspace open windowWidth={1000} />);
      expect(desktop.requests[2]).toMatchObject({ open: true, width: 640 });
      await screen.rerender(<Workspace open windowWidth={1640} />);
      await act(() => desktop.resize(1640));
      await act(() => desktop.requests[2]!.answer("resized"));
      expect(widthOf(chat)).toBe(1000);

      // A thread without the panel drops it at once, and the window still sheds its width.
      await screen.rerender(<Workspace open={false} windowWidth={1640} scopeKey="other" />);
      await expect.element(screen.getByTestId("panel")).not.toBeInTheDocument();
      expect(desktop.requests[3]).toMatchObject({ open: false, width: 640 });
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

  it("a view replacing another with the panel open asks again for the grown window", async () => {
    await withCleanStorage(async () => {
      using desktop = fakeDesktopWindow(1000);
      // The hook only needs React and the desktop bridge; no navigation is involved.
      await using screen = await render(<Workspace key="a" open windowWidth={1000} />, {
        router: false,
      });
      await screen.rerender(<Workspace key="b" open windowWidth={1000} />);
      await act(() => Promise.resolve());
      // The old view's growth is not given back, and the new view waits on the same window.
      expect(desktop.requests.map(({ open }) => open)).toEqual([true, true]);
      await expect.element(screen.getByTestId("panel")).not.toBeInTheDocument();
      await screen.rerender(<Workspace key="b" open windowWidth={1540} />);
      await act(() => desktop.resize(1540));
      await expect.element(screen.getByTestId("panel")).toBeInTheDocument();
      await act(() => desktop.requests[1]!.answer("resized"));

      await screen.unmount();
      await act(() => Promise.resolve());
      expect(desktop.requests.map(({ open }) => open)).toEqual([true, true, false]);
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
      await expect.element(screen.getByTestId("panel")).not.toBeInTheDocument();
      await act(() => desktop.requests[0]!.answer("unchanged"));
      expect(widthOf(screen.getByTestId("chat").element())).toBe(600);
      expect(localStorage.getItem(CHAT_STORAGE_KEY)).toBe("600");
    });
  });
});
