import type { RightPanelWindowRequest, RightPanelWindowResult } from "@t3tools/contracts";
import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import {
  keepChatColumnBeside,
  type PanelWidthHandle,
  readPreviewPanelWidth,
} from "./usePreviewPanelInlineSize";
import { useStableCallback } from "./useStableCallback";

type DesktopBridge = NonNullable<Window["desktopBridge"]>;

/**
 * Fork: the desktop window grows for the right panel, so there the panel joins and leaves
 * the layout in the resize that widens or narrows the viewport for it, never before. The
 * chat keeps its width in every frame, and the panel is never laid out inside the old
 * window. In a browser the layout shows the panel as soon as it is open.
 */
export function useRightPanelWindow(input: {
  readonly open: boolean;
  /** A change of thread swaps the whole view, so its panel closes without waiting. */
  readonly scopeKey: string | null;
  readonly row: HTMLElement | null;
  readonly widthStorageKey: string;
}): {
  /** Whether the layout shows the panel. */
  readonly shown: boolean;
  /** Fork: the panel's handle, so closing takes off the width the panel has then. */
  readonly panelWidthRef: (handle: PanelWidthHandle | null) => void;
} {
  const { open, scopeKey } = input;
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const [layout, setLayout] = useState({ shown: open && bridge === undefined, scopeKey });
  let shown = bridge === undefined ? open : layout.shown;
  if (bridge !== undefined && layout.scopeKey !== scopeKey) {
    // The window already grown for the last thread's panel shows this one's at once.
    shown = layout.shown && open;
    setLayout({ shown, scopeKey });
  }
  // What the window was last asked for; null until the first request.
  const sentOpen = useRef<boolean | null>(null);
  const stopFollowing = useRef<(() => void) | null>(null);
  // A panel unmounting in the commit that closes it is gone before the close is sent.
  const lastPanelWidth = useRef<PanelWidthHandle | null>(null);
  const panelWidthRef = useStableCallback((handle: PanelWidthHandle | null) => {
    if (handle !== null) lastPanelWidth.current = handle;
  });
  // Closing takes off the panel's width as it is now, so the chat column keeps its width.
  const closingPanelWidth = useStableCallback(
    () => lastPanelWidth.current?.keepPanelWidth() ?? readPreviewPanelWidth(input.widthStorageKey),
  );
  const show = useStableCallback((next: boolean, resized: boolean) => {
    if (next === shown) return;
    const { row } = input;
    // The panel takes what the window gave it, or the chat gave up, and the chat keeps the
    // rest. A window found already grown keeps the widths saved while it was.
    if (next && resized && row !== null) {
      keepChatColumnBeside(input.widthStorageKey, row.clientWidth);
    }
    // A resize has to change the layout before that frame is painted.
    flushSync(() =>
      setLayout((current) =>
        current.scopeKey === scopeKey ? { ...current, shown: next } : current,
      ),
    );
  });

  const syncWindow = useStableCallback((open: boolean) => {
    if (bridge === undefined) return;
    // A view taking over a window grown for the last one asks again; the window answers
    // once it is as asked, at once if it already is.
    const takenOver = sentOpen.current === null && takeOverGrowth();
    if (!takenOver && sentOpen.current === open) return;
    const firstRequest = sentOpen.current === null && !takenOver;
    sentOpen.current = open;
    if (!open && firstRequest) return;
    stopFollowing.current?.();
    const width = open ? readPreviewPanelWidth(input.widthStorageKey) : closingPanelWidth();
    stopFollowing.current = followWindow(bridge, { open, width }, show);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the native window to resize for the panel, and follows its resizes
  useLayoutEffect(() => syncWindow(open), [open, syncWindow]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- gives back the window's growth when the view goes away with the panel open
  useLayoutEffect(
    () => () => {
      stopFollowing.current?.();
      stopFollowing.current = null;
      if (sentOpen.current !== true || bridge === undefined) return;
      sentOpen.current = null;
      releaseGrowthSoon(bridge, closingPanelWidth());
    },
    [bridge, closingPanelWidth],
  );
  return { shown, panelWidthRef };
}

const noop = () => {};

/**
 * A view unmounting with the panel open gives the growth back a microtask later, so a
 * view mounting in the same commit (a remount, or StrictMode's replay) takes it over
 * instead of the window shrinking and growing again.
 */
let pendingRelease: { cancelled: boolean } | null = null;

function releaseGrowthSoon(bridge: DesktopBridge, panelWidth: number) {
  const release = { cancelled: false };
  pendingRelease = release;
  queueMicrotask(() => {
    if (release.cancelled) return;
    pendingRelease = null;
    void bridge.setRightPanelOpen({ open: false, width: panelWidth }).catch(noop);
  });
}

function takeOverGrowth(): boolean {
  if (pendingRelease === null) return false;
  pendingRelease.cancelled = true;
  pendingRelease = null;
  return true;
}

/**
 * Follows one request. While it is out, the panel joins the layout in the resize that
 * widens the viewport and leaves in the one that narrows it. Opening, the window draws the
 * page at the grown size before it grows; closing, it shrinks first. The answer comes once
 * the page has drawn at the window's final size and settles on what was asked.
 */
function followWindow(
  bridge: DesktopBridge,
  request: RightPanelWindowRequest,
  show: (shown: boolean, resized: boolean) => void,
): () => void {
  let width = window.innerWidth;
  let following = true;
  const onResize = () => {
    const next = window.innerWidth;
    if (next !== width) show(next > width, true);
    width = next;
  };
  const stop = () => {
    following = false;
    window.removeEventListener("resize", onResize);
  };
  const settle = (result: RightPanelWindowResult) => {
    if (!following) return;
    stop();
    show(request.open, result !== "unchanged");
  };
  window.addEventListener("resize", onResize);
  // A window that cannot be asked is one that could not grow.
  bridge.setRightPanelOpen(request).then(settle, () => settle("noRoom"));
  return stop;
}
