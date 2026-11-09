// Fork: the main window grows to the right when the right panel opens, so the
// sidebar and chat keep their widths. Upstream lets the panel share the window.
import type { RightPanelWindowRequest, RightPanelWindowResult } from "@t3tools/contracts";
import * as Electron from "electron";

import { RIGHT_PANEL_WINDOW_INTERRUPTED_CHANNEL } from "../ipc/channels.ts";

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

/** The width the last request left the window at, until anything else resizes it. */
const requestedByWindow = new WeakMap<
  Electron.BrowserWindow,
  { readonly requestId: number; readonly width: number }
>();
const watchedWindows = new WeakSet<Electron.BrowserWindow>();

const isZoomed = (window: Electron.BrowserWindow) => window.isFullScreen() || window.isMaximized();

/**
 * The renderer holds its layout until its viewport reaches the requested width, so any
 * other resize first (a hand resize, maximize, a display change) has to release it.
 */
function watchForOtherResizes(window: Electron.BrowserWindow) {
  if (watchedWindows.has(window)) return;
  watchedWindows.add(window);
  window.on("resize", () => {
    const requested = requestedByWindow.get(window);
    if (requested === undefined || window.isDestroyed()) return;
    if (window.getBounds().width === requested.width) return;
    requestedByWindow.delete(window);
    window.webContents.send(
      RIGHT_PANEL_WINDOW_INTERRUPTED_CHANNEL,
      requested.requestId,
      contentWidthOf(window),
    );
  });
}

// The renderer measures in CSS pixels; window bounds are in screen points.
const contentWidthOf = (window: Electron.BrowserWindow) =>
  window.getContentBounds().width / window.webContents.getZoomFactor();

function resizeTo(window: Electron.BrowserWindow, requestId: number, bounds: Rect) {
  watchForOtherResizes(window);
  // macOS reports this resize synchronously; it is ours, so nothing is watched yet.
  requestedByWindow.delete(window);
  window.setBounds(bounds);
  requestedByWindow.set(window, { requestId, width: window.getBounds().width });
  return { requestId, status: "resized" as const, contentWidth: contentWidthOf(window) };
}

/** `request.width` is the width to grow by (opening) or the panel's width now (closing). */
export function setWindowPanelOpen(
  window: Electron.BrowserWindow,
  request: RightPanelWindowRequest,
): RightPanelWindowResult {
  const { requestId } = request;
  if (window.isDestroyed()) return { requestId, status: "unchanged" };
  const growth = growthByWindow.get(window);
  const zoomFactor = window.webContents.getZoomFactor();
  if (request.open) {
    if (growth !== undefined) return { requestId, status: "unchanged" };
    if (isZoomed(window)) return { requestId, status: "noRoom" };
    const bounds = window.getBounds();
    const next = growForPanel(
      bounds,
      Electron.screen.getDisplayMatching(bounds).workArea,
      request.width * zoomFactor,
    );
    if (next === null) return { requestId, status: "noRoom" };
    growthByWindow.set(window, next.growth);
    return resizeTo(window, requestId, next.bounds);
  }
  // A zoomed window keeps its growth, so its normal bounds still account for it.
  if (growth === undefined || isZoomed(window)) return { requestId, status: "unchanged" };
  growthByWindow.delete(window);
  const bounds = window.getBounds();
  const next = shrinkAfterPanel(
    bounds,
    growth,
    request.width * zoomFactor,
    window.getMinimumSize()[0] ?? 0,
  );
  if (next.width === bounds.width && next.x === bounds.x) return { requestId, status: "unchanged" };
  return resizeTo(window, requestId, next);
}

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
