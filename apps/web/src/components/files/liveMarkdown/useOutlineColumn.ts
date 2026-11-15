import * as Schema from "effect/Schema";
import { type RefObject, useLayoutEffect, useState } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { observeResize } from "~/lib/observeResize";

const PINNED_STORAGE_KEY = "t3code.markdownOutlinePinned";
/** Below this the page would be narrower than about 24rem beside the column, so the outline stays a menu. */
const OUTLINE_COLUMN_MIN_WIDTH = 560;

export interface OutlineColumn {
  /** The panel has room for the column, so the outline button shows or hides it. */
  readonly fits: boolean;
  /** The reader's remembered choice to show the column. */
  readonly pinned: boolean;
  readonly togglePinned: () => void;
  readonly shown: boolean;
}

/** Whether the live editor's outline sits in a column beside the page, measured on `content`. */
export function useOutlineColumn(
  content: RefObject<HTMLElement | null>,
  enabled: boolean,
): OutlineColumn {
  const [pinned, setPinned] = useLocalStorage(PINNED_STORAGE_KEY, true, Schema.Boolean);
  const [wide, setWide] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the panel's width, which the browser lays out
  useLayoutEffect(() => {
    const element = content.current;
    if (!enabled || !element) return;
    // Measured before paint too, so the column does not first appear inside a resize callback.
    // oxlint-disable-next-line react/set-state-in-effect -- reads the browser's layout, which render cannot
    setWide(element.getBoundingClientRect().width >= OUTLINE_COLUMN_MIN_WIDTH);
    return observeResize(element, ([entry]) => {
      if (entry) setWide(entry.contentRect.width >= OUTLINE_COLUMN_MIN_WIDTH);
    });
  }, [content, enabled]);

  const fits = enabled && wide;
  return { fits, pinned, togglePinned: () => setPinned(!pinned), shown: fits && pinned };
}
