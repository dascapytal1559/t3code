import type * as Electron from "electron";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({
  screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 25, width: 1800, height: 1100 } }) },
}));
import { RIGHT_PANEL_WINDOW_INTERRUPTED_CHANNEL } from "../ipc/channels.ts";
import { growForPanel, setWindowPanelOpen, shrinkAfterPanel } from "./PanelWindowGrowth.ts";

const workArea = { x: 0, y: 25, width: 1800, height: 1100 };
const window = (x: number, width: number) => ({ x, y: 100, width, height: 900 });

type Bounds = ReturnType<typeof window>;

/** A frameless window: its content fills its bounds, and resize fires inside setBounds, as on macOS. */
function fakeBrowserWindow(initial: Bounds, options: { zoomFactor?: number } = {}) {
  let bounds = initial;
  let maximized = false;
  const resizeListeners: Array<() => void> = [];
  const sent: unknown[][] = [];
  const emitResize = () => resizeListeners.forEach((listener) => listener());
  const fake = {
    isDestroyed: () => false,
    isFullScreen: () => false,
    isMaximized: () => maximized,
    getBounds: () => bounds,
    getContentBounds: () => bounds,
    getMinimumSize: () => [840, 620],
    setBounds: (next: Bounds) => {
      bounds = next;
      emitResize();
    },
    on: (event: string, listener: () => void) => {
      if (event === "resize") resizeListeners.push(listener);
    },
    webContents: {
      getZoomFactor: () => options.zoomFactor ?? 1,
      send: (...message: unknown[]) => sent.push(message),
    },
  };
  return {
    window: fake as unknown as Electron.BrowserWindow,
    sent,
    get bounds() {
      return bounds;
    },
    /** Something other than a panel request resizes the window. */
    resizeElsewhere(width: number, options: { maximize?: boolean } = {}) {
      maximized = options.maximize ?? maximized;
      bounds = { ...bounds, width };
      emitResize();
    },
  };
}

describe("setWindowPanelOpen", () => {
  it("answers with the viewport width it resized to, in CSS pixels", () => {
    const desktop = fakeBrowserWindow(window(100, 1000), { zoomFactor: 1.25 });
    expect(setWindowPanelOpen(desktop.window, { requestId: 1, open: true, width: 540 })).toEqual({
      requestId: 1,
      status: "resized",
      contentWidth: 1340,
    });
    expect(desktop.bounds).toEqual(window(100, 1675));
    expect(setWindowPanelOpen(desktop.window, { requestId: 2, open: true, width: 540 })).toEqual({
      requestId: 2,
      status: "unchanged",
    });
    expect(setWindowPanelOpen(desktop.window, { requestId: 3, open: false, width: 540 })).toEqual({
      requestId: 3,
      status: "resized",
      contentWidth: 800,
    });
    expect(setWindowPanelOpen(desktop.window, { requestId: 4, open: false, width: 540 })).toEqual({
      requestId: 4,
      status: "unchanged",
    });
  });

  it("says when there is no room to grow, so the renderer stops waiting", () => {
    const full = fakeBrowserWindow(window(0, 1800));
    expect(setWindowPanelOpen(full.window, { requestId: 1, open: true, width: 540 })).toEqual({
      requestId: 1,
      status: "noRoom",
    });
    const maximized = fakeBrowserWindow(window(100, 1000));
    maximized.resizeElsewhere(1800, { maximize: true });
    expect(setWindowPanelOpen(maximized.window, { requestId: 2, open: true, width: 540 })).toEqual({
      requestId: 2,
      status: "noRoom",
    });
  });

  it("reports a resize it did not make, once, for the request it overtook", () => {
    const desktop = fakeBrowserWindow(window(100, 1000));
    setWindowPanelOpen(desktop.window, { requestId: 7, open: true, width: 540 });
    // Its own resize, and a move that keeps the width, are not interruptions.
    desktop.resizeElsewhere(1540);
    expect(desktop.sent).toEqual([]);

    desktop.resizeElsewhere(1600);
    desktop.resizeElsewhere(1650);
    expect(desktop.sent).toEqual([[RIGHT_PANEL_WINDOW_INTERRUPTED_CHANNEL, 7, 1600]]);

    setWindowPanelOpen(desktop.window, { requestId: 8, open: false, width: 650 });
    expect(desktop.sent).toHaveLength(1);
  });
});

describe("growForPanel", () => {
  it.each([
    {
      name: "room to the right: grows in place",
      bounds: window(100, 1000),
      expected: {
        bounds: window(100, 1540),
        growth: { added: 540, gaveWay: 0, shiftedLeft: 0, grownX: 100 },
      },
    },
    {
      name: "near the right edge: moves left only as far as needed",
      bounds: window(500, 1000),
      expected: {
        bounds: window(260, 1540),
        growth: { added: 540, gaveWay: 0, shiftedLeft: 240, grownX: 260 },
      },
    },
    {
      name: "screen too narrow: grows as far as it can, the chat gives way for the rest",
      bounds: window(200, 1500),
      expected: {
        bounds: window(0, 1800),
        growth: { added: 300, gaveWay: 240, shiftedLeft: 200, grownX: 0 },
      },
    },
    {
      name: "already as wide as the screen: no change",
      bounds: window(0, 1800),
      expected: null,
    },
  ])("$name", ({ bounds, expected }) => {
    expect(growForPanel(bounds, workArea, 540)).toEqual(expected);
  });

  it("respects a work area that starts right of zero", () => {
    expect(growForPanel(window(2500, 1000), { ...workArea, x: 1800 }, 540)?.bounds).toEqual(
      window(1800 + 1800 - 1540, 1540),
    );
  });
});

describe("shrinkAfterPanel", () => {
  const grow = (bounds: ReturnType<typeof window>) => {
    const result = growForPanel(bounds, workArea, 540);
    if (result === null) throw new Error("expected growth");
    return result;
  };

  it.each([
    { name: "in place", start: window(100, 1000) },
    { name: "after moving left at the edge", start: window(500, 1000) },
    { name: "after a partial grow on a narrow screen", start: window(200, 1500) },
  ])("returns to the starting bounds $name", ({ start }) => {
    const { bounds, growth } = grow(start);
    expect(shrinkAfterPanel(bounds, growth, 540, 840)).toEqual(start);
  });

  it.each([
    { name: "wider", resized: 1740, panel: 740 },
    { name: "narrower", resized: 1390, panel: 390 },
  ])("takes a hand resize back with the panel it went to ($name)", ({ resized, panel }) => {
    const { growth } = grow(window(100, 1000));
    expect(shrinkAfterPanel(window(100, resized), growth, panel, 840)).toEqual(window(100, 1000));
  });

  it("gives the chat back what it gave up after a partial grow", () => {
    const { growth } = grow(window(200, 1500));
    expect(shrinkAfterPanel(window(0, 1700), growth, 440, 840)).toEqual(window(200, 1500));
  });

  it("leaves a window moved by hand where it is", () => {
    const { growth } = grow(window(500, 1000));
    expect(shrinkAfterPanel(window(50, 1540), growth, 540, 840)).toEqual(window(50, 1000));
  });

  it("stops at the minimum width and moves back only by what it removed", () => {
    const { growth } = grow(window(500, 1000));
    expect(shrinkAfterPanel(window(260, 1200), growth, 540, 840)).toEqual(window(500, 840));
    expect(shrinkAfterPanel(window(260, 900), growth, 540, 840)).toEqual(window(320, 840));
  });
});
