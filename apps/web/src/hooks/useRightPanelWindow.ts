import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { type PanelChatColumn, readPreviewPanelWidth } from "./usePreviewPanelInlineSize";
import { useStableCallback } from "./useStableCallback";

/** A resize that never arrives must not leave the row held at a stale width. */
const WINDOW_RESIZE_TIMEOUT_MS = 500;

/**
 * Fork: the window grows for the right panel and shrinks after it, a frame or more after
 * the layout changes. Meanwhile the row holds its width, so the chat column never moves:
 * opening lays the panel out past the window's edge, and closing keeps it until the
 * window has shrunk. The hold ends inside the resize event, so it lands in that frame.
 */
export function useRightPanelWindow(input: {
  readonly open: boolean;
  readonly row: HTMLElement | null;
  /** The panel sits beside the chat column, so holding the row keeps the chat still. */
  readonly inline: boolean;
  /** A change of thread swaps the whole view, so it closes the panel without holding. */
  readonly scopeKey: string | null;
  readonly widthStorageKey: string;
}): {
  readonly holdingOpen: boolean;
  readonly holdingClose: boolean;
  /** Fork: the panel's handle, so the window keeps the chat width as it resizes. */
  readonly chatColumnRef: (handle: PanelChatColumn | null) => void;
} {
  const { open, inline, scopeKey } = input;
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const [settled, setSettled] = useState({ open, scopeKey });
  const holding =
    bridge !== undefined && inline && settled.open !== open && settled.scopeKey === scopeKey;
  if (!holding && (settled.open !== open || settled.scopeKey !== scopeKey)) {
    setSettled({ open, scopeKey });
  }
  // What the window was last asked for; null until the first request, which never holds.
  const sentOpen = useRef<boolean | null>(null);
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

  const syncWindow = useStableCallback((open: boolean, held: boolean) => {
    if (bridge === undefined) return;
    if (sentOpen.current === null && takeOverGrowth()) sentOpen.current = true;
    if (sentOpen.current === open) return;
    const firstRequest = sentOpen.current === null;
    sentOpen.current = open;
    if (!open && firstRequest) return;
    const { row } = input;
    const panelWidth = open ? readPreviewPanelWidth(input.widthStorageKey) : closingPanelWidth();
    const release =
      held && row !== null ? holdRowWidth(row, row.clientWidth + (open ? panelWidth : 0)) : noop;
    if (held && open) chatColumn.current?.keepChatColumn();
    const settle = (changed: number | null) =>
      flushSync(() => {
        release();
        if (open && (held || changed !== null)) chatColumn.current?.keepChatColumn();
        if (held) setSettled({ open, scopeKey });
      });
    // A held change settles on the first resize; a first open also needs the growth it got.
    const stopWaiting = whenWindowResized(bridge.setRightPanelOpen(open, panelWidth), {
      needsAnswer: !held,
      settle,
    });
    return () => {
      stopWaiting();
      release();
    };
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resizes the native window, holding the row's width before paint until it has changed
  useLayoutEffect(() => syncWindow(open, holding), [open, holding, syncWindow]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- gives back the window's growth when the view goes away with the panel open
  useLayoutEffect(
    () => () => {
      if (sentOpen.current !== true || bridge === undefined) return;
      sentOpen.current = null;
      releaseGrowthSoon(bridge, closingPanelWidth());
    },
    [bridge, closingPanelWidth],
  );
  return { holdingOpen: holding && open, holdingClose: holding && !open, chatColumnRef };
}

const noop = () => {};

/**
 * A view unmounting with the panel open gives the growth back a microtask later, so a
 * view mounting in the same commit (a remount, or StrictMode's replay) takes it over
 * instead of the window shrinking and growing again.
 */
let pendingRelease: { cancelled: boolean } | null = null;

function releaseGrowthSoon(bridge: NonNullable<Window["desktopBridge"]>, panelWidth: number) {
  const release = { cancelled: false };
  pendingRelease = release;
  queueMicrotask(() => {
    if (release.cancelled) return;
    pendingRelease = null;
    void bridge.setRightPanelOpen(false, panelWidth).catch(noop);
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
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    properties.forEach((property, index) => row.style.setProperty(property, previous[index]!));
  };
}

/**
 * Settles once the viewport has changed width, or at once when the window answers that
 * nothing changed. Returns a cancel function.
 */
function whenWindowResized(
  answer: Promise<number | null>,
  options: { readonly needsAnswer: boolean; readonly settle: (changed: number | null) => void },
): () => void {
  const viewportWidth = window.innerWidth;
  let answered = false;
  let changed: number | null = null;
  let timeout = 0;
  let done = false;
  const finish = () => {
    if (done) return;
    stop();
    options.settle(changed);
  };
  const onResize = () => {
    if (window.innerWidth !== viewportWidth && (answered || !options.needsAnswer)) finish();
  };
  const stop = () => {
    done = true;
    window.removeEventListener("resize", onResize);
    window.clearTimeout(timeout);
  };
  window.addEventListener("resize", onResize);
  void answer.then(
    (value) => {
      if (done) return;
      answered = true;
      changed = value;
      if (value === null || value < 1 || window.innerWidth !== viewportWidth) finish();
      else timeout = window.setTimeout(finish, WINDOW_RESIZE_TIMEOUT_MS);
    },
    () => {
      if (done) return;
      finish();
    },
  );
  return stop;
}
