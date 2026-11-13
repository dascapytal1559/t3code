// Fork: the main window grows to the right when the right panel opens, so the
// sidebar and chat keep their widths. Upstream lets the panel share the window.
import type { RightPanelWindowRequest, RightPanelWindowResult } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Electron from "electron";

import type { PageView } from "./PanelPageView.ts";

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PanelGrowth {
  readonly added: number;
  /** What the chat gave up for the panel because the work area stopped the window growing. */
  readonly gaveWay: number;
  readonly shiftedLeft: number;
  /** The left edge right after growing; any other value means the window was moved by hand. */
  readonly grownX: number;
}

/** Grows right by the panel width, moving left only as far as the work area needs. */
export function growForPanel(
  bounds: Rect,
  workArea: Rect,
  panelWidth: number,
): { readonly bounds: Rect; readonly growth: PanelGrowth } | null {
  const areaRight = workArea.x + workArea.width;
  const panel = Math.max(0, Math.round(panelWidth));
  const wanted = bounds.width + panel;
  const overflow = bounds.x + wanted - areaRight;
  const shiftedLeft = Math.max(0, Math.min(overflow, bounds.x - workArea.x));
  const x = bounds.x - shiftedLeft;
  const width = Math.min(wanted, Math.max(bounds.width, areaRight - x));
  const added = width - bounds.width;
  if (added <= 0) return null;
  return {
    bounds: { ...bounds, x, width },
    growth: { added, gaveWay: panel - added, shiftedLeft, grownX: x },
  };
}

/**
 * Takes off the panel's width as it is now, less what the chat gave up for it, so the
 * chat keeps its width. A hand resize while open went to the panel, so it goes with it.
 */
export function shrinkAfterPanel(
  bounds: Rect,
  growth: PanelGrowth,
  panelWidth: number,
  minWidth: number,
): Rect {
  const width = Math.max(
    minWidth,
    bounds.width - Math.max(0, Math.round(panelWidth) - growth.gaveWay),
  );
  const removed = bounds.width - width;
  const shift = bounds.x === growth.grownX ? Math.min(growth.shiftedLeft, removed) : 0;
  return { ...bounds, x: bounds.x + shift, width };
}

const growthByWindow = new WeakMap<Electron.BrowserWindow, PanelGrowth>();

/** Windows whose page is drawing at the grown size, before the window grows to show it. */
const openingByWindow = new WeakMap<
  Electron.BrowserWindow,
  Deferred.Deferred<RightPanelWindowResult>
>();

const isZoomed = (window: Electron.BrowserWindow) => window.isFullScreen() || window.isMaximized();

/** `panelWidth` is in CSS pixels; window bounds are in screen points. */
function planGrowth(window: Electron.BrowserWindow, panelWidth: number) {
  if (isZoomed(window)) return null;
  const bounds = window.getBounds();
  return growForPanel(
    bounds,
    Electron.screen.getDisplayMatching(bounds).workArea,
    panelWidth * window.webContents.getZoomFactor(),
  );
}

/**
 * macOS shows a grown window at once, with the page's last frame and a blank strip beside
 * it, and Chromium does not hold the resize for the page. So the page is sized first: it
 * lays out and draws at the grown size while the window still clips it, then the window
 * grows over a frame that is already there.
 */
const openPanelWindow = Effect.fn("desktop.panelWindow.open")(function* (
  window: Electron.BrowserWindow,
  panelWidth: number,
  pageView: PageView,
): Effect.fn.Return<RightPanelWindowResult> {
  if (growthByWindow.has(window)) return "unchanged";
  // A view taking over from one that just went away asks for the growth already under way.
  const underWay = openingByWindow.get(window);
  if (underWay !== undefined) return yield* Deferred.await(underWay);
  const plan = planGrowth(window, panelWidth);
  if (plan === null) return "noRoom";
  const opening = Deferred.makeUnsafe<RightPanelWindowResult>();
  openingByWindow.set(window, opening);
  return yield* growOnceDrawn(window, panelWidth, plan.growth.added, pageView, opening).pipe(
    Effect.onExit((exit) => {
      if (openingByWindow.get(window) === opening) openingByWindow.delete(window);
      return Deferred.done(opening, exit);
    }),
  );
});

const growOnceDrawn = Effect.fn("desktop.panelWindow.growOnceDrawn")(function* (
  window: Electron.BrowserWindow,
  panelWidth: number,
  added: number,
  pageView: PageView,
  opening: Deferred.Deferred<RightPanelWindowResult>,
): Effect.fn.Return<RightPanelWindowResult> {
  const content = window.getContentBounds();
  const ahead = yield* pageView.resizeAhead(window, {
    width: content.width + added,
    height: content.height,
  });
  if (ahead) yield* pageView.drawn(window);
  // A close while the page drew took the page back to the window's size.
  if (openingByWindow.get(window) !== opening) return "unchanged";
  openingByWindow.delete(window);
  if (window.isDestroyed()) return "unchanged";
  // The window may have been moved, resized or zoomed by hand while the page drew.
  const grown = planGrowth(window, panelWidth);
  if (grown === null) {
    if (ahead) yield* pageView.resizeAhead(window, window.getContentBounds());
    return "noRoom";
  }
  growthByWindow.set(window, grown.growth);
  window.setBounds(grown.bounds);
  if (!ahead) yield* pageView.drawn(window);
  return "resized";
});

/** The window shrinks at once and clips the page, which then draws at the new size. */
const closePanelWindow = Effect.fn("desktop.panelWindow.close")(function* (
  window: Electron.BrowserWindow,
  panelWidth: number,
  pageView: PageView,
): Effect.fn.Return<RightPanelWindowResult> {
  if (openingByWindow.delete(window)) {
    const sized = yield* pageView.resizeAhead(window, window.getContentBounds());
    if (sized) yield* pageView.drawn(window);
    return sized ? "resized" : "unchanged";
  }
  const growth = growthByWindow.get(window);
  // A zoomed window keeps its growth, so its normal bounds still account for it.
  if (growth === undefined || isZoomed(window)) return "unchanged";
  growthByWindow.delete(window);
  const bounds = window.getBounds();
  const next = shrinkAfterPanel(
    bounds,
    growth,
    panelWidth * window.webContents.getZoomFactor(),
    window.getMinimumSize()[0] ?? 0,
  );
  if (next.width === bounds.width && next.x === bounds.x) return "unchanged";
  window.setBounds(next);
  yield* pageView.drawn(window);
  return "resized";
});

/** `request.width` is the width to grow by (opening) or the panel's width now (closing). */
export const setWindowPanelOpen = (
  window: Electron.BrowserWindow,
  request: RightPanelWindowRequest,
  pageView: PageView,
): Effect.Effect<RightPanelWindowResult> => {
  if (window.isDestroyed()) return Effect.succeed("unchanged");
  return request.open
    ? openPanelWindow(window, request.width, pageView)
    : closePanelWindow(window, request.width, pageView);
};

/**
 * Saved bounds leave out the panel's width at opening, so a restart with the panel open
 * grows once. The main process does not see later panel resizes, so those are kept.
 */
export function boundsWithoutPanel<B extends Rect>(window: Electron.BrowserWindow, bounds: B): B {
  const growth = growthByWindow.get(window);
  if (growth === undefined) return bounds;
  const panelAtOpen = growth.added + growth.gaveWay;
  return {
    ...bounds,
    ...shrinkAfterPanel(bounds, growth, panelAtOpen, window.getMinimumSize()[0] ?? 0),
  };
}
