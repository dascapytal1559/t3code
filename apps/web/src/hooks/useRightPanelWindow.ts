import type { RightPanelWindowResult } from "@t3tools/contracts";
import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { type PanelChatColumn, readPreviewPanelWidth } from "./usePreviewPanelInlineSize";
import { useStableCallback } from "./useStableCallback";
import { observeResize } from "../lib/observeResize";

type DesktopBridge = NonNullable<Window["desktopBridge"]>;
type WindowOutcome = RightPanelWindowResult["status"] | "interrupted";

/**
 * Fork: the window resizes for the right panel a frame or more after the layout changes.
 * Meanwhile the row holds its width, so the chat never moves: the panel sits inline past
 * the window's edge (never a sheet inside it) until the resize that reaches the width
 * the window reported, which ends the hold in that frame. There is no timeout.
 */
export function useRightPanelWindow(input: {
  readonly open: boolean;
  readonly row: HTMLElement | null;
  /** The panel fills the chat area, so there is no chat column to hold. */
  readonly maximized: boolean;
  /** The layout shows the panel as a sheet, which closes as a sheet without holding. */
  readonly sheet: boolean;
  /** A change of thread swaps the whole view, so it closes the panel without holding. */
  readonly scopeKey: string | null;
  readonly widthStorageKey: string;
}): {
  readonly holdingOpen: boolean;
  readonly holdingClose: boolean;
  /** Fork: the panel's handle, so the window keeps the chat width as it resizes. */
  readonly chatColumnRef: (handle: PanelChatColumn | null) => void;
} {
  const { open, scopeKey } = input;
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const holdable = bridge !== undefined && !input.maximized;
  const [layout, setLayout] = useState({ open, scopeKey, holding: false });
  let holding = layout.holding && holdable;
  if (layout.open !== open || layout.scopeKey !== scopeKey) {
    // Reversing a held change keeps holding: the window is still on its way.
    holding = holdable && layout.scopeKey === scopeKey && (open || !input.sheet || layout.holding);
    setLayout({ open, scopeKey, holding });
  } else if (layout.holding && !holding) {
    setLayout({ open, scopeKey, holding });
  }
  // What the window was last asked for; null until the first request, which never holds.
  const sentOpen = useRef<boolean | null>(null);
  const cancelRequest = useRef<(() => void) | null>(null);
  const releaseRow = useRef<(() => void) | null>(null);
  const chatColumn = useRef<PanelChatColumn | null>(null);
  // A panel unmounting in the commit that closes it is gone before the close is sent.
  const lastChatColumn = useRef<PanelChatColumn | null>(null);
  const chatColumnRef = useStableCallback((handle: PanelChatColumn | null) => {
    chatColumn.current = handle;
    if (handle !== null) lastChatColumn.current = handle;
  });
  // Closing takes off the panel's width as it is now, so the chat column keeps its width.
  const closingPanelWidth = useStableCallback(
    () => lastChatColumn.current?.keepPanelWidth() ?? readPreviewPanelWidth(input.widthStorageKey),
  );
  const letGoOfRow = () => {
    releaseRow.current?.();
    releaseRow.current = null;
  };

  const syncWindow = useStableCallback((open: boolean, held: boolean) => {
    if (bridge === undefined) return;
    if (sentOpen.current === null && takeOverGrowth()) sentOpen.current = true;
    if (!held) letGoOfRow();
    if (sentOpen.current === open) return;
    const firstRequest = sentOpen.current === null;
    sentOpen.current = open;
    if (!open && firstRequest) return;
    cancelRequest.current?.();
    const { row } = input;
    const panelWidth = open ? readPreviewPanelWidth(input.widthStorageKey) : closingPanelWidth();
    // A reversal keeps the row it held: the chat column and the panel, either way.
    if (held && releaseRow.current === null && row !== null) {
      releaseRow.current = holdRowWidth(row, row.clientWidth + (open ? panelWidth : 0));
    }
    if (held && open) chatColumn.current?.keepChatColumn();
    const settle = (outcome: WindowOutcome) =>
      flushSync(() => {
        cancelRequest.current = null;
        letGoOfRow();
        // Whatever else resized the window gave or took the panel's width, like a hand resize.
        if (open && outcome !== "interrupted" && (held || outcome !== "unchanged")) {
          chatColumn.current?.keepChatColumn();
        }
        if (held) {
          setLayout((current) =>
            current.open === open && current.scopeKey === scopeKey
              ? { ...current, holding: false }
              : current,
          );
        }
      });
    cancelRequest.current = requestWindow(bridge, open, panelWidth, settle);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resizes the native window, holding the row's width before paint until it has changed
  useLayoutEffect(() => syncWindow(open, holding), [open, holding, syncWindow]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- gives back the window's growth when the view goes away with the panel open
  useLayoutEffect(
    () => () => {
      cancelRequest.current?.();
      cancelRequest.current = null;
      releaseRow.current?.();
      releaseRow.current = null;
      if (sentOpen.current !== true || bridge === undefined) return;
      sentOpen.current = null;
      releaseGrowthSoon(bridge, closingPanelWidth());
    },
    [bridge, closingPanelWidth],
  );
  return { holdingOpen: holding && open, holdingClose: holding && !open, chatColumnRef };
}

const noop = () => {};

let lastRequestId = 0;

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
    void bridge
      .setRightPanelOpen({ requestId: ++lastRequestId, open: false, width: panelWidth })
      .catch(noop);
  });
}

function takeOverGrowth(): boolean {
  if (pendingRelease === null) return false;
  pendingRelease.cancelled = true;
  pendingRelease = null;
  return true;
}

/** Min and max pin the width whichever way the parent flexes, leaving the height alone. */
function holdRowWidth(row: HTMLElement, width: number): () => void {
  const properties = ["width", "min-width", "max-width"] as const;
  const previous = properties.map((property) => row.style.getPropertyValue(property));
  for (const property of properties) row.style.setProperty(property, `${width}px`);
  return () => {
    properties.forEach((property, index) => row.style.setProperty(property, previous[index]!));
  };
}

/**
 * Asks the window to resize and settles once the viewport is at the width it reported,
 * at once when it reports no change, or as the viewport follows a resize from elsewhere.
 * Widths on the way there keep waiting. Returns a cancel function.
 */
function requestWindow(
  bridge: DesktopBridge,
  open: boolean,
  width: number,
  settle: (outcome: WindowOutcome) => void,
): () => void {
  const requestId = ++lastRequestId;
  let result: RightPanelWindowResult | null = null;
  let interruption: { readonly contentWidth: number; readonly viewport: number } | null = null;
  let done = false;
  const finish = (outcome: WindowOutcome) => {
    if (done) return;
    stop();
    settle(outcome);
  };
  // Fractional zoom can leave a target between two whole CSS pixels.
  const reached = (contentWidth: number) => Math.abs(window.innerWidth - contentWidth) < 1;
  const check = () => {
    if (interruption !== null) {
      // The window is elsewhere now; the hold ends as the viewport follows it.
      if (reached(interruption.contentWidth) || window.innerWidth !== interruption.viewport) {
        finish("interrupted");
      }
    } else if (result !== null) {
      if (result.status !== "resized") finish(result.status);
      else if (reached(result.contentWidth)) finish("resized");
    }
  };
  // Listening starts before the request, so geometry that beats the answer is not missed.
  window.addEventListener("resize", check);
  const stopObserving = observeResize(document.documentElement, check);
  const stopInterrupted = bridge.onRightPanelWindowInterrupted((event) => {
    if (done || event.requestId !== requestId) return;
    interruption = { contentWidth: event.contentWidth, viewport: window.innerWidth };
    check();
  });
  const stop = () => {
    done = true;
    window.removeEventListener("resize", check);
    stopObserving();
    stopInterrupted();
  };
  bridge.setRightPanelOpen({ requestId, open, width }).then(
    (answer) => {
      if (done || answer.requestId !== requestId) return;
      result = answer;
      check();
    },
    () => finish("unchanged"),
  );
  return stop;
}
