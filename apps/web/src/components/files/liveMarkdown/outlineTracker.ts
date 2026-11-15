import { syntaxTree } from "@codemirror/language";
import { type EditorView, type PluginValue, ViewPlugin, type ViewUpdate } from "@codemirror/view";

import { type EditorHeading, headingsOf } from "./editorOutline";
import type { OutlineItem } from "./outline";

export interface OutlineSnapshot {
  readonly headings: readonly OutlineItem[];
  /** The section being read, as an index into `headings`; -1 above the first heading. */
  readonly active: number;
}

/** The section `pos` is in: the last heading that starts at or before it, or -1. */
function sectionAt(headings: readonly { readonly from: number }[], pos: number): number {
  let low = 0;
  let high = headings.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (headings[mid]!.from <= pos) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}

// A jump leaves its heading this far below the top, so it counts as the top line.
const TOP_MARGIN = 13;

/** The caret's place while it is on screen, otherwise the first line at the top of the view. */
function readingPosition(view: EditorView): number {
  const scroller = view.scrollDOM.getBoundingClientRect();
  const height = (y: number) => Math.max(0, y - view.documentTop);
  const top = view.lineBlockAtHeight(height(scroller.top + TOP_MARGIN));
  const bottom = view.lineBlockAtHeight(height(scroller.bottom));
  const head = view.state.selection.main.head;
  return head >= top.from && head <= bottom.to ? head : top.from;
}

const sameHeadings = (a: readonly OutlineItem[], b: readonly OutlineItem[]) =>
  a.length === b.length &&
  a.every((heading, index) => heading.level === b[index]!.level && heading.text === b[index]!.text);

export const NO_OUTLINE: OutlineSnapshot = { headings: [], active: -1 };

/**
 * Follows the file's headings and the section being read, for the pinned outline.
 * It does the work only while something listens, and hands out the same snapshot
 * until the outline or the section changes.
 */
class OutlineTracker implements PluginValue {
  private headings: EditorHeading[] | null = null;
  private snapshot = NO_OUTLINE;
  private stale = true;
  private readonly listeners = new Set<() => void>();
  private readonly onScroll = () => this.changed();

  constructor(private readonly view: EditorView) {
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
  }

  update(update: ViewUpdate) {
    const reparsed =
      update.docChanged || syntaxTree(update.state) !== syntaxTree(update.startState);
    if (reparsed) this.headings = null;
    if (reparsed || update.selectionSet || update.geometryChanged) this.changed();
  }

  /** The outline as it is now; the same object until it changes. */
  current(): OutlineSnapshot {
    if (this.stale) this.refresh();
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    this.changed();
    return () => void this.listeners.delete(listener);
  }

  destroy() {
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.listeners.clear();
  }

  private changed() {
    this.stale = true;
    if (this.listeners.size === 0) return;
    // Layout cannot be read during an update, so the section is found in the measure phase.
    this.view.requestMeasure({
      key: this,
      read: () => this.refresh(),
      write: (changed) => {
        if (changed) for (const listener of this.listeners) listener();
      },
    });
  }

  /** Brings the snapshot up to date and says whether it changed. */
  private refresh(): boolean {
    this.stale = false;
    const headings = (this.headings ??= headingsOf(this.view.state));
    const active = sectionAt(headings, readingPosition(this.view));
    const previous = this.snapshot;
    if (active === previous.active && sameHeadings(headings, previous.headings)) return false;
    this.snapshot = {
      headings: sameHeadings(headings, previous.headings)
        ? previous.headings
        : headings.map(({ level, text }) => ({ level, text })),
      active,
    };
    return true;
  }
}

export const outlineTracker = ViewPlugin.fromClass(OutlineTracker);
