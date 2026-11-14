import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  type Line,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { markdownFrontmatterLength } from "@t3tools/shared/markdownFrontmatter";

import { HEADING_NODE } from "./markdownSyntax";
import {
  BulletWidget,
  CalloutTitleWidget,
  CheckboxWidget,
  CodeLabelWidget,
  FrontmatterWidget,
  OrderedWidget,
  RuleWidget,
} from "./widgets";

// The document is the file's exact text. Decorations hide syntax marks and swap
// blocks for widgets wherever the caret is not, so nothing is ever converted.

/** Tells the preview whether the editor has focus; only a focused editor shows syntax at the caret. */
export const setFocused = StateEffect.define<boolean>();
const focusField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setFocused)) return effect.value;
    return value;
  },
});

const FRONTMATTER_SCAN_CHARS = 65_536;

function frontmatterEnd(state: EditorState): number {
  const head = state.doc.sliceString(0, FRONTMATTER_SCAN_CHARS);
  const length = markdownFrontmatterLength(head);
  // A fence cut off by the scan limit would read as closed.
  return length === head.length && state.doc.length > head.length ? 0 : length;
}

/** Length of the leading frontmatter block, 0 without one. The Markdown grammar does not know it. */
export const frontmatterField = StateField.define<number>({
  create: frontmatterEnd,
  update(value, tr) {
    if (!tr.docChanged) return value;
    // The opening fence sits in the first four characters; a byte order mark may lead it.
    if (!tr.state.doc.sliceString(0, 4).includes("---")) return 0;
    let touched = value === 0;
    tr.changes.iterChangedRanges((from) => {
      if (from <= value) touched = true;
    });
    return touched ? frontmatterEnd(tr.state) : value;
  },
});

/** What the selection touches while the editor has focus; nothing otherwise, so all is drawn. */
function touchOf(state: EditorState) {
  const ranges = state.field(focusField) && !state.readOnly ? state.selection.ranges : [];
  const touches = (from: number, to: number) =>
    ranges.some((range) => range.from <= to && range.to >= from);
  return {
    touches,
    onLines: (from: number, to: number) =>
      touches(state.doc.lineAt(from).from, state.doc.lineAt(to).to),
  };
}

function previewInputsChanged(before: EditorState, after: EditorState): boolean {
  return (
    before.field(focusField) !== after.field(focusField) ||
    before.field(frontmatterField) !== after.field(frontmatterField) ||
    syntaxTree(before) !== syntaxTree(after)
  );
}

// Widgets that replace whole lines change the layout, which CodeMirror only
// accepts from a state field. They cover the whole document, not the viewport.
export function blockDecorations(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = [];
  const frontmatter = state.field(frontmatterField);
  if (frontmatter > 0 && !touchOf(state).onLines(0, frontmatter)) {
    const widget = new FrontmatterWidget(state.doc.sliceString(0, frontmatter));
    out.push(Decoration.replace({ widget, block: true }).range(0, frontmatter));
  }
  return Decoration.set(out);
}

const blockPreview = StateField.define<DecorationSet>({
  create: blockDecorations,
  update(value, tr) {
    return tr.docChanged ||
      tr.selection !== undefined ||
      previewInputsChanged(tr.startState, tr.state)
      ? blockDecorations(tr.state)
      : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const hidden = Decoration.replace({});
const syntaxMark = Decoration.mark({ class: "cm-lp-syntax" });
const strongMark = Decoration.mark({ class: "cm-lp-strong" });
const emphasisMark = Decoration.mark({ class: "cm-lp-em" });
const strikeMark = Decoration.mark({ class: "cm-lp-strike" });
const codeMark = Decoration.mark({ class: "cm-lp-code" });
const indentMark = Decoration.mark({ class: "cm-lp-indent" });

/** Width of one column of list indentation, which `.cm-lp-indent` draws in a fixed-width font. */
const REM_PER_INDENT_COLUMN = 0.625;

function indentColumns(text: string): number {
  let columns = 0;
  for (const char of text) columns += char === "\t" ? 4 - (columns % 4) : 1;
  return columns;
}

const rem = (value: number) => `${value.toFixed(3)}rem`;

interface VisibleRange {
  readonly from: number;
  readonly to: number;
}

/** Marks, hidden syntax and small widgets for the lines on screen. */
export function inlineDecorations(
  state: EditorState,
  visibleRanges: readonly VisibleRange[],
): DecorationSet {
  const { doc } = state;
  const tree = syntaxTree(state);
  const touch = touchOf(state);
  const frontmatter = state.field(frontmatterField);
  const out: Range<Decoration>[] = [];
  const add = (from: number, to: number, decoration: Decoration) => {
    if (to > from) out.push(decoration.range(from, to));
  };
  const lineStyle = (line: Line, className: string, style?: string) => {
    out.push(
      Decoration.line({ class: className, ...(style ? { attributes: { style } } : {}) }).range(
        line.from,
      ),
    );
  };

  for (const visible of visibleRanges) {
    const firstLine = doc.lineAt(visible.from);
    const lastLine = doc.lineAt(visible.to);
    const windowFrom = firstLine.from;
    /** Visits the lines of a block that are on screen. */
    const eachLine = (from: number, to: number, visit: (line: Line) => void) => {
      const last = Math.min(doc.lineAt(to).number, lastLine.number);
      const first = Math.max(doc.lineAt(from).number, firstLine.number);
      for (let number = first; number <= last; number += 1) visit(doc.line(number));
    };
    // Lines kept at full height: code, and blocks shown as their source.
    const verbatim: Array<readonly [number, number]> = [];

    if (frontmatter > 0 && windowFrom < frontmatter) {
      verbatim.push([0, frontmatter]);
      if (touch.onLines(0, frontmatter)) {
        eachLine(0, frontmatter, (line) => lineStyle(line, "cm-lp-src-line"));
      }
    }

    tree.iterate({
      from: Math.max(windowFrom, frontmatter),
      to: lastLine.to,
      enter(ref) {
        const { name, from, to } = ref;
        if (to <= frontmatter) return false;

        const heading = HEADING_NODE.exec(name);
        if (heading) {
          eachLine(from, to, (line) => lineStyle(line, `cm-lp-h cm-lp-h${heading[1]}`));
          return;
        }
        if (name === "HeaderMark") {
          const parent = ref.node.parent;
          if (!parent?.name.startsWith("ATXHeading") || touch.onLines(from, to)) {
            add(from, to, syntaxMark);
          } else if (from === parent.from) {
            add(from, Math.min(to + 1, doc.lineAt(from).to), hidden);
          } else {
            add(from, to, hidden);
          }
          return;
        }

        if (name === "StrongEmphasis") return void add(from, to, strongMark);
        if (name === "Emphasis") return void add(from, to, emphasisMark);
        if (name === "Strikethrough") return void add(from, to, strikeMark);
        if (name === "EmphasisMark" || name === "StrikethroughMark") {
          const parent = ref.node.parent;
          if (parent) add(from, to, touch.touches(parent.from, parent.to) ? syntaxMark : hidden);
          return;
        }
        if (name === "InlineCode") {
          const marks = ref.node.getChildren("CodeMark");
          const open = marks[0];
          const close = marks.at(-1);
          if (open && close && close.from >= open.to) {
            add(open.to, close.from, codeMark);
            const shown = touch.touches(from, to);
            add(open.from, open.to, shown ? syntaxMark : hidden);
            add(close.from, close.to, shown ? syntaxMark : hidden);
          }
          return false;
        }
        if (name === "Escape") {
          if (!touch.touches(from, to)) add(from, from + 1, hidden);
          return;
        }

        if (name === "ListItem") {
          const listMark = ref.node.getChild("ListMark");
          if (!listMark) return;
          const first = doc.lineAt(from);
          const lead = doc.sliceString(first.from, listMark.from);
          const markText = doc.sliceString(listMark.from, listMark.to);
          const ordered = ref.node.parent?.name === "OrderedList";
          const task = ref.node.getChild("Task") !== null;
          const gutter = ordered
            ? Math.max(1.25, 0.6 * (markText.length + 0.6))
            : task
              ? 1.5
              : 1.25;
          // Inside a quote the line starts with quote marks, which are no indentation.
          if (/^[ \t]*$/.test(lead)) {
            const hang = indentColumns(lead) * REM_PER_INDENT_COLUMN + gutter;
            const nested = ["BulletList", "OrderedList"].flatMap((type) =>
              ref.node
                .getChildren(type)
                .map((list) => [doc.lineAt(list.from).number, doc.lineAt(list.to).number] as const),
            );
            eachLine(from, to, (line) => {
              if (line.number === first.number) {
                lineStyle(
                  line,
                  "cm-lp-li",
                  `padding-inline-start:${rem(hang)};text-indent:-${rem(hang)}`,
                );
                add(line.from, listMark.from, indentMark);
                return;
              }
              const inNested = nested.some(
                ([start, end]) => line.number >= start && line.number <= end,
              );
              if (inNested || line.text.trim() === "") return;
              // A continuation line hangs its own indentation, so its text lines up with the item's.
              const indent = /^[ \t]*/.exec(line.text)?.[0] ?? "";
              const width = indentColumns(indent) * REM_PER_INDENT_COLUMN;
              lineStyle(
                line,
                "cm-lp-li",
                `padding-inline-start:${rem(Math.max(hang, width))};text-indent:-${rem(width)}`,
              );
              add(line.from, line.from + indent.length, indentMark);
            });
          }
          const markEnd = Math.min(listMark.to + 1, first.to);
          if (touch.touches(listMark.from, listMark.to)) {
            add(
              listMark.from,
              markEnd,
              Decoration.mark({
                class: "cm-lp-list-mark",
                ...(task ? {} : { attributes: { style: `min-width:${rem(gutter)}` } }),
              }),
            );
          } else if (task) {
            add(listMark.from, markEnd, hidden);
          } else if (ordered) {
            add(
              listMark.from,
              markEnd,
              Decoration.replace({ widget: new OrderedWidget(markText, gutter) }),
            );
          } else {
            add(listMark.from, markEnd, Decoration.replace({ widget: new BulletWidget() }));
          }
          return;
        }
        if (name === "TaskMarker") {
          if (!touch.touches(from, to)) {
            const checked = /[xX]/.test(doc.sliceString(from, to));
            add(
              from,
              Math.min(to + 1, doc.lineAt(from).to),
              Decoration.replace({ widget: new CheckboxWidget(checked) }),
            );
          }
          return;
        }

        if (name === "Blockquote") {
          const first = doc.lineAt(from);
          const callout = /^\s*>\s*\[!(\w+)\][+-]?[ \t]*(.*)$/.exec(first.text);
          const kind = callout?.[1]?.toLowerCase();
          const className = kind
            ? `cm-lp-quote cm-lp-callout cm-lp-callout-${kind}`
            : "cm-lp-quote";
          eachLine(from, to, (line) => lineStyle(line, className));
          if (callout && kind && first.from >= windowFrom && !touch.onLines(first.from, first.to)) {
            const title = callout[2] || `${kind[0]?.toUpperCase() ?? ""}${kind.slice(1)}`;
            add(
              first.from,
              first.to,
              Decoration.replace({ widget: new CalloutTitleWidget(kind, title) }),
            );
          }
          return;
        }
        if (name === "QuoteMark") {
          if (touch.onLines(from, to)) add(from, to, syntaxMark);
          else add(from, doc.sliceString(to, to + 1) === " " ? to + 1 : to, hidden);
          return;
        }

        if (name === "FencedCode") {
          verbatim.push([from, to]);
          const first = doc.lineAt(from);
          const last = doc.lineAt(to);
          const fences = ref.node.getChildren("CodeMark");
          const closing = fences.length > 1 ? fences.at(-1) : undefined;
          const closed =
            closing !== undefined && closing.from >= last.from && last.number > first.number;
          const inside = touch.touches(from, to);
          eachLine(from, to, (line) => {
            const classes = ["cm-lp-codeblock"];
            if (line.number === first.number) classes.push("cm-lp-codeblock-first");
            if (line.number === last.number) classes.push("cm-lp-codeblock-last");
            if (line.number === first.number || (closed && line.number === last.number)) {
              classes.push(inside ? "cm-lp-fence" : "cm-lp-fence cm-lp-fence-quiet");
            }
            lineStyle(line, classes.join(" "));
          });
          if (!inside) {
            const info = ref.node.getChild("CodeInfo");
            const language = info ? doc.sliceString(info.from, info.to).trim().split(/\s/)[0] : "";
            if (from >= windowFrom) {
              add(
                from,
                first.to,
                Decoration.replace({ widget: new CodeLabelWidget(language ?? "") }),
              );
            }
            if (closed) add(closing.from, last.to, hidden);
          }
          return;
        }
        if (name === "CodeBlock") {
          verbatim.push([from, to]);
          const first = doc.lineAt(from).number;
          const last = doc.lineAt(to).number;
          eachLine(from, to, (line) => {
            const classes = ["cm-lp-codeblock"];
            if (line.number === first) classes.push("cm-lp-codeblock-first");
            if (line.number === last) classes.push("cm-lp-codeblock-last");
            lineStyle(line, classes.join(" "));
          });
          return false;
        }

        if (name === "Table") {
          verbatim.push([from, to]);
          eachLine(from, to, (line) => lineStyle(line, "cm-lp-src-line"));
          return false;
        }

        if (name === "HorizontalRule") {
          if (touch.onLines(from, to)) add(from, to, syntaxMark);
          else add(from, to, Decoration.replace({ widget: new RuleWidget() }));
          return;
        }
      },
    });

    // Blank lines separate blocks; drawn shorter, they read as paragraph spacing.
    for (let number = firstLine.number; number <= lastLine.number; number += 1) {
      const line = doc.line(number);
      if (line.text.trim() !== "") continue;
      if (verbatim.some(([from, to]) => line.from >= from && line.from <= to)) continue;
      lineStyle(line, "cm-lp-blank");
    }
  }

  return Decoration.set(out, true);
}

const inlinePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = inlineDecorations(view.state, view.visibleRanges);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        previewInputsChanged(update.startState, update.state)
      ) {
        this.decorations = inlineDecorations(update.state, update.view.visibleRanges);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** Draws the Markdown in place: the page stays rendered while it is edited. */
export function livePreview(): Extension {
  return [
    focusField,
    EditorView.focusChangeEffect.of((_state, focusing) => setFocused.of(focusing)),
    frontmatterField,
    blockPreview,
    inlinePreview,
    EditorView.editorAttributes.of({ class: "cm-live-preview" }),
  ];
}
