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
  const wanted = bounds.width + Math.max(0, Math.round(panelWidth));
  const overflow = bounds.x + wanted - areaRight;
  const shiftedLeft = Math.max(0, Math.min(overflow, bounds.x - workArea.x));
  const x = bounds.x - shiftedLeft;
  const width = Math.min(wanted, Math.max(bounds.width, areaRight - x));
  const added = width - bounds.width;
  if (added <= 0) return null;
  return { bounds: { ...bounds, x, width }, growth: { added, shiftedLeft, grownX: x } };
}

/** Takes off only what growing added, so a hand resize while open is kept. */
export function shrinkAfterPanel(bounds: Rect, growth: PanelGrowth, minWidth: number): Rect {
  const width = Math.max(minWidth, bounds.width - growth.added);
  const removed = bounds.width - width;
  const shift = bounds.x === growth.grownX ? Math.min(growth.shiftedLeft, removed) : 0;
  return { ...bounds, x: bounds.x + shift, width };
}

const growthByWindow = new WeakMap<Electron.BrowserWindow, PanelGrowth>();

const isZoomed = (window: Electron.BrowserWindow) => window.isFullScreen() || window.isMaximized();

export function setWindowPanelOpen(
  window: Electron.BrowserWindow,
  open: boolean,
  panelWidth: number,
): void {
  if (window.isDestroyed()) return;
  const growth = growthByWindow.get(window);
  if (open) {
    if (growth !== undefined || isZoomed(window)) return;
    const bounds = window.getBounds();
    const next = growForPanel(
      bounds,
      Electron.screen.getDisplayMatching(bounds).workArea,
      // The renderer measures in CSS pixels; window bounds are in screen points.
      panelWidth * window.webContents.getZoomFactor(),
    );
    if (next === null) return;
    growthByWindow.set(window, next.growth);
    window.setBounds(next.bounds);
    return;
  }
  // A zoomed window keeps its growth, so its normal bounds still account for it.
  if (growth === undefined || isZoomed(window)) return;
  growthByWindow.delete(window);
  window.setBounds(shrinkAfterPanel(window.getBounds(), growth, window.getMinimumSize()[0] ?? 0));
}

/** Saved bounds leave out the panel's width, so a restart with the panel open grows once. */
export function boundsWithoutPanel<B extends Rect>(window: Electron.BrowserWindow, bounds: B): B {
  const growth = growthByWindow.get(window);
  if (growth === undefined) return bounds;
  return { ...bounds, ...shrinkAfterPanel(bounds, growth, window.getMinimumSize()[0] ?? 0) };
}
