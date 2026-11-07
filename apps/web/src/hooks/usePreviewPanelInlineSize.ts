import * as Schema from "effect/Schema";
import { useLayoutEffect, useRef, useState } from "react";

import { getLocalStorageItem, setLocalStorageItem } from "./useLocalStorage";
import { RESIZABLE_WIDTH_PROPERTY, type ResizableWidthHandlers } from "./useResizableWidth";
import { useResizeDrag } from "./useResizeDrag";
import { useStableCallback } from "./useStableCallback";
import { observeResize } from "../lib/observeResize";

export interface PreviewPanelInlineSize {
  readonly width: number;
  readonly handlers: ResizableWidthHandlers;
  /** Ref-callback body for the panel host: measures the row the panel shares. */
  readonly observeRow: (host: HTMLElement) => () => void;
  /**
   * Fork: re-measures the row and keeps the chat column at what the panel
   * leaves of it, when the desktop window resizes for the panel.
   */
  readonly keepChatColumn: () => void;
}

export type PanelChatColumn = Pick<PreviewPanelInlineSize, "keepChatColumn">;

const PREVIEW_PANEL_WIDTH_STORAGE_KEY = "t3code:preview-panel-width";
const PREVIEW_PANEL_MIN_WIDTH = 360;
const PREVIEW_PANEL_MAX_WIDTH_FRACTION = 0.7;
/** Below this, the sibling chat column's composer overflows. */
const SIBLING_COLUMN_MIN_WIDTH = 360;
const PREVIEW_PANEL_DEFAULT_WIDTH = 540;

const WidthSchema = Schema.Finite;

interface StoredWidths {
  readonly storageKey: string;
  /** The panel width last set by a drag, which a desktop window grows by. */
  readonly panelWidth: number | null;
  /** The chat column width the panel keeps; null until the row first changes or a drag. */
  readonly chatWidth: number | null;
}

/**
 * The chat column keeps its width and the panel takes the rest of the row, so
 * a window resize lands on the panel. The panel gives way first, down to its
 * minimum, then the chat column, down to its own.
 */
export function resolvePreviewPanelWidth(input: {
  readonly rowWidth: number | null;
  readonly chatWidth: number | null;
  readonly panelWidth: number;
  readonly viewportWidth: number;
}): number {
  const max = getPreviewPanelMaxWidth(input.viewportWidth, input.rowWidth);
  const wanted =
    input.rowWidth === null || input.chatWidth === null
      ? input.panelWidth
      : input.rowWidth - input.chatWidth;
  return Math.max(PREVIEW_PANEL_MIN_WIDTH, Math.min(max, wanted));
}

export function usePreviewPanelInlineSize(
  options: {
    readonly enabled?: boolean | undefined;
    readonly widthStorageKey?: string | undefined;
    readonly defaultWidth?: number | undefined;
    readonly container?: HTMLElement | null | undefined;
  } = {},
): PreviewPanelInlineSize {
  const enabled = options.enabled ?? true;
  const container = options.container;
  const storageKey = options.widthStorageKey ?? PREVIEW_PANEL_WIDTH_STORAGE_KEY;
  const defaultWidth = options.defaultWidth ?? PREVIEW_PANEL_DEFAULT_WIDTH;
  const [stored, setStored] = useState(() => readStoredWidths(storageKey));
  if (stored.storageKey !== storageKey) {
    setStored(readStoredWidths(storageKey));
  }
  const [rowWidth, setRowWidth] = useState<number | null>(null);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  const rowRef = useRef<HTMLElement | null>(null);
  const panelWidth = stored.panelWidth ?? defaultWidth;
  const resolve = (row: number | null, chatWidth: number | null) =>
    resolvePreviewPanelWidth({ rowWidth: row, chatWidth, panelWidth, viewportWidth });
  const width = resolve(rowWidth, stored.chatWidth);
  const maxWidth = getPreviewPanelMaxWidth(viewportWidth, rowWidth);

  const commit = (next: Omit<StoredWidths, "storageKey">, key = storageKey) => {
    // Resizing remains usable for this session when browser storage is unavailable.
    setStored({ storageKey: key, ...next });
    try {
      if (next.panelWidth !== null) {
        setLocalStorageItem(key, next.panelWidth, WidthSchema);
      }
      if (next.chatWidth !== null) {
        setLocalStorageItem(chatWidthStorageKey(key), next.chatWidth, WidthSchema);
      }
    } catch (error) {
      console.error("Could not persist panel width.", error);
    }
  };
  const keepChatColumnFor = (row: number) => {
    commit({ panelWidth: stored.panelWidth, chatWidth: row - resolve(row, null) });
  };

  const measure = useStableCallback(() => {
    const row = rowRef.current;
    if (row === null) {
      setViewportWidth(window.innerWidth);
      return;
    }
    const next = row.clientWidth;
    // The first row change pins the chat column at the width it had, so the panel absorbs it.
    if (enabled && stored.chatWidth === null && rowWidth !== null && next !== rowWidth) {
      keepChatColumnFor(rowWidth);
    }
    setRowWidth(next);
  });

  const observeRow = (host: HTMLElement) => {
    const row = container ?? (enabled ? host.parentElement : null) ?? null;
    rowRef.current = row;
    // Ref callbacks run before paint, so the width is clamped without an over-wide flash on mount.
    measure();
    if (row !== null) {
      const stopObserving = observeResize(row, measure);
      return () => {
        if (rowRef.current === row) rowRef.current = null;
        stopObserving();
      };
    }
    let frame = 0;
    const onResize = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  };

  const keepChatColumn = useStableCallback(() => {
    const row = rowRef.current?.clientWidth;
    if (row === undefined) return;
    setRowWidth(row);
    keepChatColumnFor(row);
  });

  const restoreWidth = useStableCallback((host: HTMLElement | null) => {
    host?.style.setProperty(RESIZABLE_WIDTH_PROPERTY, `${width}px`);
  });
  const drag = useResizeDrag<HTMLElement>((event) => {
    const host = event.currentTarget.parentElement;
    // Disable drag transitions through transition-property; the host renders transition-duration.
    host?.style.setProperty("transition-property", "none");
    // The drag commits to the key it started from, even if the panel switches keys before release.
    const startStorageKey = storageKey;
    const startWidth = width;
    return {
      width: startWidth,
      edge: "left",
      bounds: { min: PREVIEW_PANEL_MIN_WIDTH, max: maxWidth },
      resize(nextWidth) {
        host?.style.setProperty(RESIZABLE_WIDTH_PROPERTY, `${nextWidth}px`);
        return nextWidth;
      },
      finish(finalWidth, moved) {
        if (!moved) {
          restoreWidth(host);
          return;
        }
        const row = rowRef.current?.clientWidth;
        commit(
          {
            panelWidth: finalWidth,
            chatWidth: row === undefined ? stored.chatWidth : row - finalWidth,
          },
          startStorageKey,
        );
      },
      cleanup(committed) {
        host?.style.removeProperty("transition-property");
        if (!committed) host?.style.setProperty(RESIZABLE_WIDTH_PROPERTY, `${startWidth}px`);
      },
    };
  });
  // Bounds can change mid-drag (sidebar opens, window narrows), and the render
  // that carries them rewrites the committed width, so re-apply the live pointer position.
  const { refresh } = drag;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reapplies the live drag pointer position to the DOM before paint when the bounds change
  useLayoutEffect(
    () => refresh({ min: PREVIEW_PANEL_MIN_WIDTH, max: maxWidth }),
    [refresh, maxWidth],
  );

  return {
    width,
    handlers: {
      ref: drag.ref,
      onPointerDown: drag.onPointerDown,
      onPointerMove: drag.onPointerMove,
      onPointerUp: drag.onPointerUp,
      onPointerCancel: drag.onPointerCancel,
      onLostPointerCapture: drag.onLostPointerCapture,
    },
    observeRow,
    keepChatColumn,
  };
}

/** Fork: the saved width before the window caps it, which the desktop window grows by. */
export function readPreviewPanelWidth(storageKey = PREVIEW_PANEL_WIDTH_STORAGE_KEY): number {
  return Math.max(
    PREVIEW_PANEL_MIN_WIDTH,
    readStoredWidth(storageKey) ?? PREVIEW_PANEL_DEFAULT_WIDTH,
  );
}

function chatWidthStorageKey(storageKey: string): string {
  return `${storageKey}:chat-column`;
}

function readStoredWidths(storageKey: string): StoredWidths {
  return {
    storageKey,
    panelWidth: readStoredWidth(storageKey),
    chatWidth: readStoredWidth(chatWidthStorageKey(storageKey)),
  };
}

function readStoredWidth(storageKey: string): number | null {
  if (typeof window === "undefined") return null;
  try {
    return getLocalStorageItem(storageKey, WidthSchema);
  } catch {
    // Unreadable storage falls back to the default.
    return null;
  }
}

function getPreviewPanelMaxWidth(viewportWidth: number, rowWidth: number | null): number {
  const cap =
    rowWidth === null
      ? Math.floor(viewportWidth * PREVIEW_PANEL_MAX_WIDTH_FRACTION)
      : Math.floor(rowWidth) - SIBLING_COLUMN_MIN_WIDTH;
  // Keep max >= min; an inverted clamp would overwrite the saved width on drag end.
  return Math.max(PREVIEW_PANEL_MIN_WIDTH, cap);
}
