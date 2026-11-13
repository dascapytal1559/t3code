import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({
  screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 25, width: 1800, height: 1100 } }) },
}));
import type { PageView, PageViewSize } from "./PanelPageView.ts";
import { growForPanel, setWindowPanelOpen, shrinkAfterPanel } from "./PanelWindowGrowth.ts";

const workArea = { x: 0, y: 25, width: 1800, height: 1100 };
const window = (x: number, width: number) => ({ x, y: 100, width, height: 900 });

type Bounds = ReturnType<typeof window>;

/** A frameless window: its content fills its bounds. */
function fakeBrowserWindow(initial: Bounds, options: { zoomFactor?: number } = {}) {
  let bounds = initial;
  let maximized = false;
  let resizes = 0;
  const fake = {
    isDestroyed: () => false,
    isFullScreen: () => false,
    isMaximized: () => maximized,
    getBounds: () => bounds,
    getContentBounds: () => bounds,
    getMinimumSize: () => [840, 620],
    setBounds: (next: Bounds) => {
      bounds = next;
      resizes += 1;
    },
    webContents: { getZoomFactor: () => options.zoomFactor ?? 1 },
  };
  return {
    window: fake as unknown as Electron.BrowserWindow,
    get bounds() {
      return bounds;
    },
    /** How often a panel request resized the window. */
    get resizes() {
      return resizes;
    },
    maximize(width: number) {
      maximized = true;
      bounds = { ...bounds, width };
    },
  };
}

/** A page that records the sizes its view was given, and draws a frame only when told to. */
function fakePageView(options: { ahead?: boolean } = {}) {
  const sizes: PageViewSize[] = [];
  const frames: Array<Deferred.Deferred<void>> = [];
  const pageView: PageView = {
    resizeAhead: (_window, { width, height }) =>
      Effect.sync(() => {
        if (options.ahead === false) return false;
        sizes.push({ width, height });
        return true;
      }),
    drawn: () => {
      const frame = Deferred.makeUnsafe<void>();
      frames.push(frame);
      return Deferred.await(frame);
    },
  };
  /** Lets the oldest awaited frame through. */
  const draw = Effect.suspend(() => Deferred.succeed(frames.shift()!, undefined));
  return { pageView, sizes, draw };
}

const start = Effect.forkChild({ startImmediately: true });

describe("setWindowPanelOpen", () => {
  it.effect("draws the page at the grown size before the window grows", () =>
    Effect.gen(function* () {
      const desktop = fakeBrowserWindow(window(100, 1000), { zoomFactor: 1.25 });
      const page = fakePageView();
      const request = (open: boolean) =>
        setWindowPanelOpen(desktop.window, { open, width: 540 }, page.pageView);

      const opening = yield* request(true).pipe(start);
      // 540 CSS pixels at zoom 1.25 are 675 screen points.
      expect(page.sizes).toEqual([{ width: 1675, height: 900 }]);
      expect(desktop.bounds).toEqual(window(100, 1000));
      yield* page.draw;
      expect(yield* Fiber.join(opening)).toBe("resized");
      expect(desktop.bounds).toEqual(window(100, 1675));
      expect(yield* request(true)).toBe("unchanged");

      const closing = yield* request(false).pipe(start);
      // The window shrinks at once; the answer waits for the page's frame at that size.
      expect(desktop.bounds).toEqual(window(100, 1000));
      yield* page.draw;
      expect(yield* Fiber.join(closing)).toBe("resized");
      expect(yield* request(false)).toBe("unchanged");
    }),
  );

  it.effect("says when there is no room to grow, and leaves the page alone", () =>
    Effect.gen(function* () {
      const page = fakePageView();
      const full = fakeBrowserWindow(window(0, 1800));
      expect(
        yield* setWindowPanelOpen(full.window, { open: true, width: 540 }, page.pageView),
      ).toBe("noRoom");
      const maximized = fakeBrowserWindow(window(100, 1000));
      maximized.maximize(1800);
      expect(
        yield* setWindowPanelOpen(maximized.window, { open: true, width: 540 }, page.pageView),
      ).toBe("noRoom");
      expect(page.sizes).toEqual([]);
    }),
  );

  it.effect("a close while the page draws takes the page back and never grows the window", () =>
    Effect.gen(function* () {
      const desktop = fakeBrowserWindow(window(100, 1000));
      const page = fakePageView();
      const request = (open: boolean) =>
        setWindowPanelOpen(desktop.window, { open, width: 540 }, page.pageView);

      const opening = yield* request(true).pipe(start);
      const closing = yield* request(false).pipe(start);
      expect(page.sizes).toEqual([
        { width: 1540, height: 900 },
        { width: 1000, height: 900 },
      ]);
      yield* page.draw;
      yield* page.draw;
      expect(yield* Fiber.join(opening)).toBe("unchanged");
      expect(yield* Fiber.join(closing)).toBe("resized");
      expect(desktop.resizes).toBe(0);

      const reopening = yield* request(true).pipe(start);
      yield* page.draw;
      expect(yield* Fiber.join(reopening)).toBe("resized");
      expect(desktop.bounds).toEqual(window(100, 1540));
    }),
  );

  it.effect("a second request while the page draws joins the growth under way", () =>
    Effect.gen(function* () {
      const desktop = fakeBrowserWindow(window(100, 1000));
      const page = fakePageView();
      const request = setWindowPanelOpen(desktop.window, { open: true, width: 540 }, page.pageView);

      const first = yield* request.pipe(start);
      const second = yield* request.pipe(start);
      expect(page.sizes).toHaveLength(1);
      yield* page.draw;
      expect([yield* Fiber.join(first), yield* Fiber.join(second)]).toEqual(["resized", "resized"]);
      expect(desktop.resizes).toBe(1);
    }),
  );

  it.effect("grows from where the window is once the page has drawn", () =>
    Effect.gen(function* () {
      const desktop = fakeBrowserWindow(window(100, 1000));
      const page = fakePageView();
      const opening = yield* setWindowPanelOpen(
        desktop.window,
        { open: true, width: 540 },
        page.pageView,
      ).pipe(start);
      // Moved by hand while the page drew.
      desktop.window.setBounds(window(40, 1000));
      yield* page.draw;
      expect(yield* Fiber.join(opening)).toBe("resized");
      expect(desktop.bounds).toEqual(window(40, 1540));
    }),
  );

  it.effect("where the page cannot be sized ahead, the window grows first", () =>
    Effect.gen(function* () {
      const desktop = fakeBrowserWindow(window(100, 1000));
      const page = fakePageView({ ahead: false });
      const opening = yield* setWindowPanelOpen(
        desktop.window,
        { open: true, width: 540 },
        page.pageView,
      ).pipe(start);
      expect(desktop.bounds).toEqual(window(100, 1540));
      // The answer still follows the page's frame at the new size.
      yield* page.draw;
      expect(yield* Fiber.join(opening)).toBe("resized");
    }),
  );
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
