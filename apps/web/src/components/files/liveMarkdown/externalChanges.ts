import {
  Annotation,
  type EditorState,
  type Extension,
  type Range,
  StateEffect,
  StateField,
  Text,
  Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

import type { TextChange } from "./lineDiff";

/** Marks a change that came from the file on disk, not from typing. */
export const externalChange = Annotation.define<boolean>();

interface Span {
  readonly from: number;
  readonly to: number;
}

const FLASH_MS = 2000;
const flash = StateEffect.define<readonly Span[]>();
const endFlash = StateEffect.define<null>();
const flashLine = Decoration.line({ class: "cm-lp-flash" });

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let lines = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(endFlash)) lines = Decoration.none;
      if (!effect.is(flash)) continue;
      const { doc } = tr.state;
      const marked: Range<Decoration>[] = [];
      for (const span of effect.value) {
        // A span that starts or ends on a line break belongs to the lines inside it only.
        const first = doc.lineAt(span.from);
        const last = doc.lineAt(Math.min(span.to, doc.length));
        const whole = span.to > span.from;
        const from = whole && first.to === span.from ? first.number + 1 : first.number;
        const to = whole && last.from === span.to ? last.number - 1 : last.number;
        for (let number = from; number <= to; number += 1) {
          marked.push(flashLine.range(doc.line(number).from));
        }
      }
      lines = Decoration.set(marked, true);
    }
    return lines;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const flashTimer = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | undefined;
    readonly view: EditorView;
    constructor(view: EditorView) {
      this.view = view;
    }
    update(update: ViewUpdate) {
      const flashed = update.transactions.some((tr) => tr.effects.some((e) => e.is(flash)));
      if (!flashed) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.view.dispatch({ effects: endFlash.of(null) }), FLASH_MS);
    }
    destroy() {
      clearTimeout(this.timer);
    }
  },
);

/** Briefly tints lines that changed under the reader: an agent's edit, or a line a link opened at. */
export const lineFlash: Extension = [flashField, flashTimer];

export const flashSpans = (spans: readonly Span[]) => flash.of(spans);

/**
 * A transaction that applies changes made on disk. It stays out of the undo
 * history, so undo never takes back someone else's edit, and the lines it
 * wrote are tinted for a moment.
 */
export function externalChangeSpec(
  state: EditorState,
  changes: readonly TextChange[],
  extraEffects: readonly StateEffect<unknown>[] = [],
): TransactionSpec {
  const changeSet = state.changes(
    changes.map((change) => ({
      from: change.from,
      to: change.to,
      insert: Text.of(change.insert.split("\n")),
    })),
  );
  const written: Span[] = [];
  changeSet.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (toB > fromB) written.push({ from: fromB, to: toB });
    else if (!state.doc.sliceString(fromA, toA).includes("\n")) {
      written.push({ from: fromB, to: fromB });
    }
  });
  return {
    changes: changeSet,
    effects: [flash.of(written), ...extraEffects],
    annotations: [Transaction.addToHistory.of(false), externalChange.of(true)],
  };
}
