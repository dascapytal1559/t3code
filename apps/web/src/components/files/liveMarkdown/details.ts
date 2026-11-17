import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Range,
  StateEffect,
  StateField,
  Transaction,
} from "@codemirror/state";
import { Decoration, type EditorView, type KeyBinding, WidgetType } from "@codemirror/view";

import { chevronIcon } from "./widgets";

// `<details>` blocks draw folded, as the rendered view and the chat draw them.
// Whether one is open lives here, never in the file's text.

export interface DetailsBlock {
  /** Start of the `<details>` line. */
  readonly from: number;
  /** End of the last line of the opening tag and its summary. */
  readonly headerTo: number;
  /** Start of the `</details>` line. */
  readonly closeFrom: number;
  /** End of the `</details>` line. */
  readonly to: number;
  readonly summary: string;
  /** Written `<details open>`. */
  readonly startsOpen: boolean;
}

interface SourceLine {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

const OPEN_TAG = /^ {0,3}<details(\s[^>]*)?>(.*)$/i;
const CLOSE_TAG = /^ {0,3}<\/details>\s*$/i;
const SUMMARY_START = /^\s*<summary\b/i;
const SUMMARY = /^\s*<summary\b[^>]*>([\s\S]*?)<\/summary>/i;
const OPEN_ATTRIBUTE = /(?:^|\s)open(?:\s|=|$)/i;
/** A summary that never closes stops being read after this many lines. */
const MAX_SUMMARY_LINES = 6;
/** The rendered view's label for a block without a summary. */
const DEFAULT_SUMMARY = "Details";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  nbsp: " ",
};

function summaryText(html: string): string {
  const text = html
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_match, name: string) => ENTITIES[name] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text || DEFAULT_SUMMARY;
}

/** The lines of the file's top-level HTML blocks, the only place the grammar leaves tags. */
function htmlLines(state: EditorState): SourceLine[] {
  const { doc } = state;
  const lines: SourceLine[] = [];
  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
    if (node.name !== "HTMLBlock") continue;
    const last = doc.lineAt(node.to).number;
    for (let number = doc.lineAt(node.from).number; number <= last; number += 1) {
      lines.push(doc.line(number));
    }
  }
  return lines;
}

/** The file's closed `<details>` blocks, nested ones included, in the order they start. */
export function detailsBlocks(state: EditorState): DetailsBlock[] {
  const lines = htmlLines(state);
  const follows = (index: number) => {
    const line = lines[index];
    const before = lines[index - 1];
    return line !== undefined && before !== undefined && line.from === before.to + 1;
  };
  const blocks: DetailsBlock[] = [];
  const opened: Array<Omit<DetailsBlock, "closeFrom" | "to">> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (CLOSE_TAG.test(line.text)) {
      const start = opened.pop();
      if (start) blocks.push({ ...start, closeFrom: line.from, to: line.to });
      continue;
    }
    const open = OPEN_TAG.exec(line.text);
    if (!open) continue;
    const rest = open[2] ?? "";
    // A block opened and closed on one line has nothing to fold.
    if (/<\/details>/i.test(rest)) continue;
    let headerTo = line.to;
    let summary = DEFAULT_SUMMARY;
    let first = -1;
    let source = "";
    if (SUMMARY_START.test(rest)) {
      first = index;
      source = rest;
    } else if (
      rest.trim() === "" &&
      follows(index + 1) &&
      SUMMARY_START.test(lines[index + 1]!.text)
    ) {
      first = index + 1;
      source = lines[first]!.text;
    }
    if (first >= 0) {
      let end = first;
      while (!/<\/summary>/i.test(source) && end - first < MAX_SUMMARY_LINES && follows(end + 1)) {
        end += 1;
        source += `\n${lines[end]!.text}`;
      }
      const written = SUMMARY.exec(source);
      if (written) {
        summary = summaryText(written[1] ?? "");
        headerTo = lines[end]!.to;
        index = end;
      }
    }
    opened.push({
      from: line.from,
      headerTo,
      summary,
      startsOpen: OPEN_ATTRIBUTE.test(open[1] ?? ""),
    });
  }
  return blocks.sort((a, b) => a.from - b.from);
}

/** Opens or closes the block that starts at `from`. */
export const setDetailsOpen = StateEffect.define<{ readonly from: number; readonly open: boolean }>(
  {
    map: (value, changes) => ({ ...value, from: changes.mapPos(value.from, 1) }),
  },
);

export interface DetailsState {
  readonly blocks: readonly DetailsBlock[];
  /** Where each open block starts. */
  readonly open: ReadonlySet<number>;
}

const insideBody = (block: DetailsBlock, pos: number) =>
  pos > block.headerTo && pos < block.closeFrom;

function nextDetails(value: DetailsState, tr: Transaction): DetailsState {
  const toggles = tr.effects.filter((effect) => effect.is(setDetailsOpen));
  const reparsed = tr.docChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state);
  if (!reparsed && toggles.length === 0 && !tr.selection) return value;

  const map = (pos: number) => (tr.docChanged ? tr.changes.mapPos(pos, 1) : pos);
  const known = new Set(value.blocks.map((block) => map(block.from)));
  const wasOpen = new Set([...value.open].map(map));
  const blocks = reparsed ? detailsBlocks(tr.state) : value.blocks;
  // A block typed here stays open while it is written; one that arrives on disk starts as written.
  const typed = tr.docChanged && tr.annotation(Transaction.userEvent) !== undefined;
  const open = new Set<number>();
  for (const block of blocks) {
    if (known.has(block.from) ? wasOpen.has(block.from) : typed || block.startsOpen) {
      open.add(block.from);
    }
  }
  for (const effect of toggles) {
    if (effect.value.open) open.add(effect.value.from);
    else open.delete(effect.value.from);
  }
  // Find, the outline and a link to a line put the caret in a folded block, which opens it.
  if (tr.selection) {
    for (const block of blocks) {
      if (
        !open.has(block.from) &&
        tr.selection.ranges.some((range) => insideBody(block, range.head))
      ) {
        open.add(block.from);
      }
    }
  }
  const same =
    blocks === value.blocks &&
    open.size === value.open.size &&
    [...open].every((from) => value.open.has(from));
  return same ? value : { blocks, open };
}

export const detailsField = StateField.define<DetailsState>({
  create(state) {
    const blocks = detailsBlocks(state);
    return {
      blocks,
      open: new Set(blocks.filter((block) => block.startsOpen).map((block) => block.from)),
    };
  },
  update: nextDetails,
});

/** Opens or closes a block from a click, keeping the caret out of what it folds away. */
function toggle(view: EditorView, block: DetailsBlock, open: boolean) {
  const { selection, doc } = view.state;
  const caretInside = selection.ranges.some(
    (range) => range.head > block.from && range.head <= block.to,
  );
  view.dispatch({
    effects: setDetailsOpen.of({ from: block.from, open }),
    ...(!open && caretInside ? { selection: { anchor: Math.min(block.to + 1, doc.length) } } : {}),
  });
}

const blockWhere = (view: EditorView, test: (block: DetailsBlock) => boolean) =>
  view.state.field(detailsField).blocks.find(test);

/** A block's summary row, drawn like the chat's: a chevron and the summary, ruled above. */
class DetailsSummaryWidget extends WidgetType {
  readonly summary: string;
  readonly open: boolean;
  constructor(summary: string, open: boolean) {
    super();
    this.summary = summary;
    this.open = open;
  }
  override eq(other: DetailsSummaryWidget) {
    return other.summary === this.summary && other.open === this.open;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = this.open ? "cm-lp-details cm-lp-details-open" : "cm-lp-details";
    const row = document.createElement("div");
    row.className = "cm-lp-details-summary";
    row.setAttribute("role", "button");
    row.setAttribute("aria-expanded", String(this.open));
    const label = document.createElement("span");
    label.textContent = this.summary;
    row.append(chevronIcon(), label);
    wrap.append(row);
    // The press is taken so the caret stays where it was.
    wrap.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const pos = view.posAtDOM(wrap);
      const block = blockWhere(view, (candidate) => candidate.from === pos);
      if (block) toggle(view, block, !this.open);
    });
    return wrap;
  }
  override ignoreEvent() {
    return true;
  }
}

/** The rule under an open block, where its `</details>` is. */
class DetailsEndWidget extends WidgetType {
  override eq() {
    return true;
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-details-end";
    wrap.setAttribute("aria-hidden", "true");
    return wrap;
  }
}

/** Stands in for a folded block's body while its tags show as source. */
class DetailsBodyWidget extends WidgetType {
  override eq() {
    return true;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-details-body";
    const button = document.createElement("span");
    button.className = "cm-foldPlaceholder";
    button.title = "Unfold";
    button.textContent = "…";
    wrap.append(button);
    wrap.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const pos = view.posAtDOM(wrap);
      const block = blockWhere(view, (candidate) => candidate.headerTo + 1 === pos);
      if (block) toggle(view, block, true);
    });
    return wrap;
  }
  override ignoreEvent() {
    return true;
  }
}

const sourceLine = Decoration.line({ class: "cm-lp-src-line" });

/**
 * Draws each block as its summary row, folded or open. The lines of a tag the
 * selection touches show as source. Returns the ranges it hides, where nothing
 * else may be drawn.
 */
export function detailsDecorations(
  state: EditorState,
  onLines: (from: number, to: number) => boolean,
  after: number,
  out: Range<Decoration>[],
): Array<readonly [number, number]> {
  const { doc } = state;
  const { blocks, open } = state.field(detailsField);
  const hidden: Array<readonly [number, number]> = [];
  const replace = (from: number, to: number, widget: WidgetType) => {
    out.push(Decoration.replace({ widget, block: true }).range(from, to));
    hidden.push([from, to]);
  };
  const asSource = (from: number, to: number) => {
    const last = doc.lineAt(to).number;
    for (let number = doc.lineAt(from).number; number <= last; number += 1) {
      out.push(sourceLine.range(doc.line(number).from));
    }
  };
  for (const block of blocks) {
    if (block.from < after) continue;
    if (hidden.some(([from, to]) => block.from >= from && block.to <= to)) continue;
    const isOpen = open.has(block.from);
    const head = onLines(block.from, block.headerTo);
    const close = onLines(block.closeFrom, block.to);
    const summary = new DetailsSummaryWidget(block.summary, isOpen);
    const hasBody = block.closeFrom > block.headerTo + 1;
    if (isOpen) {
      if (head) asSource(block.from, block.headerTo);
      else replace(block.from, block.headerTo, summary);
      if (close) asSource(block.closeFrom, block.to);
      else replace(block.closeFrom, block.to, new DetailsEndWidget());
    } else if (!head && !close) {
      replace(block.from, block.to, summary);
    } else if (!head) {
      replace(block.from, block.closeFrom - 1, summary);
      asSource(block.closeFrom, block.to);
    } else {
      asSource(block.from, block.headerTo);
      if (close) {
        if (hasBody) replace(block.headerTo + 1, block.closeFrom - 1, new DetailsBodyWidget());
        asSource(block.closeFrom, block.to);
      } else {
        replace(block.headerTo + 1, block.to, new DetailsBodyWidget());
      }
    }
  }
  return hidden;
}

/** The innermost block whose tags or body hold the caret. */
function blockAtCaret(state: EditorState): DetailsBlock | undefined {
  const { head } = state.selection.main;
  return state
    .field(detailsField)
    .blocks.findLast((block) => block.from <= head && head <= block.to);
}

const setAll = (view: EditorView, open: boolean) => {
  const { blocks } = view.state.field(detailsField);
  if (blocks.length > 0) {
    view.dispatch({
      effects: blocks.map((block) => setDetailsOpen.of({ from: block.from, open })),
    });
  }
  // The headings fold too.
  return false;
};

/**
 * Where Up or Down puts a bare caret whose next line is a tag line drawn as a
 * widget, which the caret would otherwise jump over; null to move as usual.
 */
export function tagLineStep(state: EditorState, forward: boolean): number | null {
  const { main } = state.selection;
  if (state.selection.ranges.length > 1 || !main.empty) return null;
  const { doc } = state;
  const number = doc.lineAt(main.head).number + (forward ? 1 : -1);
  if (number < 1 || number > doc.lines) return null;
  const next = doc.line(number);
  const { blocks, open } = state.field(detailsField);
  const tags = blocks.some((block) =>
    forward
      ? block.from === next.from || (open.has(block.from) && block.closeFrom === next.from)
      : block.to === next.to || (open.has(block.from) && block.headerTo === next.to),
  );
  if (!tags) return null;
  return forward ? next.from : next.to;
}

const stepOntoTags = (forward: boolean) => (view: EditorView) => {
  const target = tagLineStep(view.state, forward);
  if (target === null) return false;
  view.dispatch({ selection: { anchor: target }, scrollIntoView: true, userEvent: "select" });
  return true;
};

/**
 * Up and Down stop on a block's tag lines, which then show as source for editing.
 * The fold keys work on the block at the caret, and fold or unfold every block with the rest.
 */
export const detailsKeymap: readonly KeyBinding[] = [
  { key: "ArrowDown", run: stepOntoTags(true) },
  { key: "ArrowUp", run: stepOntoTags(false) },
  {
    key: "Ctrl-Shift-[",
    mac: "Cmd-Alt-[",
    run(view) {
      const block = blockAtCaret(view.state);
      if (!block || !view.state.field(detailsField).open.has(block.from)) return false;
      toggle(view, block, false);
      return true;
    },
  },
  {
    key: "Ctrl-Shift-]",
    mac: "Cmd-Alt-]",
    run(view) {
      const block = blockAtCaret(view.state);
      if (!block || view.state.field(detailsField).open.has(block.from)) return false;
      toggle(view, block, true);
      return true;
    },
  },
  { key: "Ctrl-Alt-[", run: (view) => setAll(view, false) },
  { key: "Ctrl-Alt-]", run: (view) => setAll(view, true) },
];
