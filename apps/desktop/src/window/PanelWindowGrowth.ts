// Fork: the main window grows to the right when the right panel opens, so the
// sidebar and chat keep their widths. Upstream lets the panel share the window.
import * as Electron from "electron";

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

const isZoomed = (window: Electron.BrowserWindow) => window.isFullScreen() || window.isMaximized();

/**
 * `panelWidth` is the width to grow by (opening) or the panel's width now (closing).
 * Returns the CSS pixels the window grew by (opening) or shrank by (closing).
 * Null means nothing changed: opening found it already grown, or closing found nothing to undo.
 */
export function setWindowPanelOpen(
  window: Electron.BrowserWindow,
  open: boolean,
  panelWidth: number,
): number | null {
  if (window.isDestroyed()) return null;
  const growth = growthByWindow.get(window);
  if (open) {
    if (growth !== undefined) return null;
    if (isZoomed(window)) return 0;
    const bounds = window.getBounds();
    // The renderer measures in CSS pixels; window bounds are in screen points.
    const zoomFactor = window.webContents.getZoomFactor();
    const next = growForPanel(
      bounds,
      Electron.screen.getDisplayMatching(bounds).workArea,
      panelWidth * zoomFactor,
    );
    if (next === null) return 0;
    growthByWindow.set(window, next.growth);
    window.setBounds(next.bounds);
    return next.growth.added / zoomFactor;
  }
  // A zoomed window keeps its growth, so its normal bounds still account for it.
  if (growth === undefined || isZoomed(window)) return null;
  growthByWindow.delete(window);
  const bounds = window.getBounds();
  const zoomFactor = window.webContents.getZoomFactor();
  const next = shrinkAfterPanel(
    bounds,
    growth,
    panelWidth * zoomFactor,
    window.getMinimumSize()[0] ?? 0,
  );
  window.setBounds(next);
  return (bounds.width - next.width) / zoomFactor;
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
