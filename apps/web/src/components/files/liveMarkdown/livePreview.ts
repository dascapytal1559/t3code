import { syntaxTree } from "@codemirror/language";
import { searchPanelOpen } from "@codemirror/search";
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

import { detailsDecorations, detailsField } from "./details";
import { frontmatterRows } from "./frontmatter";
import { HEADING_NODE, imageEmbedOf } from "./markdownSyntax";
import {
  clickedLink,
  type ImageSource,
  type LivePreviewConfig,
  previewConfig,
} from "./previewConfig";
import {
  BulletWidget,
  CalloutTitleWidget,
  CheckboxWidget,
  CodeLabelWidget,
  FrontmatterWidget,
  ImageWidget,
  OrderedWidget,
  RuleWidget,
  TableWidget,
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

/** Gives the editor the URLs the app signed for the file's images, by asset key. */
export const setImageUrls = StateEffect.define<ReadonlyMap<string, string>>();
const imageUrlsField = StateField.define<ReadonlyMap<string, string>>({
  create: () => new Map(),
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setImageUrls)) return effect.value;
    return value;
  },
});

/** What the selection touches while the editor or its find bar has focus; nothing otherwise. */
function touchOf(state: EditorState) {
  const active = state.field(focusField) || searchPanelOpen(state);
  const ranges = active && !state.readOnly ? state.selection.ranges : [];
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
    searchPanelOpen(before) !== searchPanelOpen(after) ||
    before.field(frontmatterField) !== after.field(frontmatterField) ||
    before.field(imageUrlsField) !== after.field(imageUrlsField) ||
    before.field(detailsField) !== after.field(detailsField) ||
    syntaxTree(before) !== syntaxTree(after)
  );
}

// Widgets that replace whole lines change the layout, which CodeMirror only
// accepts from a state field. They cover the whole document, not the viewport.
export function blockDecorations(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = [];
  const { doc } = state;
  const touch = touchOf(state);
  const frontmatter = state.field(frontmatterField);
  const folded = detailsDecorations(state, touch.onLines, frontmatter, out);
  if (frontmatter > 0 && !touch.onLines(0, frontmatter)) {
    const source = doc.sliceString(0, frontmatter);
    const shown =
      frontmatterRows(source).length > 0
        ? Decoration.replace({ widget: new FrontmatterWidget(source), block: true })
        : Decoration.replace({ block: true });
    out.push(shown.range(0, frontmatter));
  }
  // Only a table at the top level is drawn; one inside a list or a quote stays as its source.
  const top = syntaxTree(state).topNode;
  for (let node = top.firstChild; node !== null; node = node.nextSibling) {
    if (node.name !== "Table" || node.from < frontmatter) continue;
    const from = doc.lineAt(node.from).from;
    const to = doc.lineAt(node.to).to;
    if (touch.touches(from, to) || folded.some(([start, end]) => from >= start && to <= end)) {
      continue;
    }
    const widget = new TableWidget(doc.sliceString(from, to));
    out.push(Decoration.replace({ widget, block: true }).range(from, to));
  }
  return Decoration.set(out, true);
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
const wikiLinkMark = Decoration.mark({ class: "cm-lp-wikilink" });
const linkMark = (href: string) =>
  Decoration.mark({ class: "cm-lp-link", attributes: { "data-href": href } });
const codeLinkMark = (href: string) =>
  Decoration.mark({
    class: "cm-lp-code cm-lp-link",
    attributes: { "data-href": href, "data-inline-code": "" },
  });

// A bare path links only in prose, not inside code, a link or an address of its own.
const NOT_PROSE = new Set([
  "InlineCode",
  "Link",
  "Image",
  "URL",
  "Autolink",
  "LinkReference",
  "FencedCode",
  "CodeBlock",
  "HTMLBlock",
  "HTMLTag",
  "Comment",
  "WikiLink",
  "ImageEmbed",
]);

function inProse(state: EditorState, position: number): boolean {
  const tree = syntaxTree(state);
  let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(position, 1);
  for (; node !== null; node = node.parent) {
    if (NOT_PROSE.has(node.name)) return false;
  }
  return true;
}

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

/**
 * Marks, hidden syntax and small widgets for the lines on screen. `onAsset`
 * hears the key of each image there that needs a URL from the app.
 */
export function inlineDecorations(
  state: EditorState,
  visibleRanges: readonly VisibleRange[],
  onAsset?: (key: string) => void,
): DecorationSet {
  const { doc } = state;
  const tree = syntaxTree(state);
  const touch = touchOf(state);
  const config = state.facet(previewConfig);
  const imageUrls = state.field(imageUrlsField);
  const frontmatter = state.field(frontmatterField);
  const out: Range<Decoration>[] = [];
  const add = (from: number, to: number, decoration: Decoration) => {
    if (to <= from) return;
    const replacesBreak = decoration.point && doc.lineAt(from).to < to;
    out.push((replacesBreak ? syntaxMark : decoration).range(from, to));
  };
  const addressOf = (source: ImageSource) => {
    if (source.kind === "url") return source.url;
    if (source.kind === "blocked") return null;
    onAsset?.(source.key);
    return imageUrls.get(source.key) ?? null;
  };
  const drawImage = (from: number, to: number, widget: ImageWidget) => {
    if (touch.onLines(from, to) || doc.lineAt(from).to < to) {
      // At the caret the source shows, with the picture after it.
      add(from, to, syntaxMark);
      out.push(Decoration.widget({ widget, side: 1 }).range(to));
    } else {
      add(from, to, Decoration.replace({ widget }));
    }
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
            const href = config.inlineCodeLink(doc.sliceString(open.to, close.from));
            add(open.to, close.from, href === null ? codeMark : codeLinkMark(href));
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

        if (name === "Link") {
          const [open, close] = ref.node.getChildren("LinkMark");
          const url = ref.node.getChild("URL");
          // A reference link has no address of its own, and an empty one nothing to show.
          if (!open || !close || !url || close.from <= open.to) return;
          add(open.to, close.from, linkMark(doc.sliceString(url.from, url.to)));
          const shown = touch.touches(from, to);
          add(from, open.to, shown ? syntaxMark : hidden);
          add(close.from, to, shown ? syntaxMark : hidden);
          return;
        }
        if (name === "Autolink") {
          const shown = touch.touches(from, to);
          for (const mark of ref.node.getChildren("LinkMark")) {
            add(mark.from, mark.to, shown ? syntaxMark : hidden);
          }
          return;
        }
        if (name === "URL") {
          const parent = ref.node.parent?.name;
          if (parent !== "Link" && parent !== "Image" && parent !== "LinkReference") {
            add(from, to, linkMark(doc.sliceString(from, to)));
          }
          return;
        }
        if (name === "WikiLink") {
          const bar = doc.sliceString(from + 2, to - 2).indexOf("|");
          const shown = touch.touches(from, to);
          // `[[note|label]]` shows its label; at the caret it shows all of itself.
          const labelFrom = shown || bar < 0 ? from + 2 : from + 2 + bar + 1;
          add(from, labelFrom, shown ? syntaxMark : hidden);
          add(labelFrom, to - 2, wikiLinkMark);
          add(to - 2, to, shown ? syntaxMark : hidden);
          return false;
        }
        if (name === "Image") {
          const [open, close] = ref.node.getChildren("LinkMark");
          const url = ref.node.getChild("URL");
          if (!open || !close || !url) return false;
          const address = addressOf(config.resolveImage(doc.sliceString(url.from, url.to)));
          drawImage(from, to, new ImageWidget(address, doc.sliceString(open.to, close.from)));
          return false;
        }
        if (name === "ImageEmbed") {
          const embed = imageEmbedOf(doc.sliceString(from + 3, to - 2));
          const address = embed ? addressOf(config.resolveImageEmbed(embed.target)) : null;
          // Until its file is found it reads as written.
          if (!embed || address === null) return false;
          drawImage(from, to, new ImageWidget(address, embed.alt, embed.width, embed.height));
          return false;
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
          // A drawn table is a block widget; this is one shown as its source.
          const topLevel = ref.node.parent?.parent === null;
          if (!topLevel || touch.touches(doc.lineAt(from).from, doc.lineAt(to).to)) {
            verbatim.push([from, to]);
            eachLine(from, to, (line) => lineStyle(line, "cm-lp-src-line"));
          }
          return false;
        }

        if (name === "HorizontalRule") {
          if (touch.onLines(from, to)) add(from, to, syntaxMark);
          else add(from, to, Decoration.replace({ widget: new RuleWidget() }));
          return;
        }
      },
    });

    eachLine(Math.max(windowFrom, frontmatter), lastLine.to, (line) => {
      for (const { index, path } of config.bareLinks(line.text)) {
        const from = line.from + index;
        if (inProse(state, from)) add(from, from + path.length, linkMark(path));
      }
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
    /** Asset keys already asked for, so each image is asked for once. */
    readonly requested = new Set<string>();
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        previewInputsChanged(update.startState, update.state)
      ) {
        this.decorations = this.build(update.view);
      }
    }
    build(view: EditorView): DecorationSet {
      const { onImageNeeded } = view.state.facet(previewConfig);
      return inlineDecorations(view.state, view.visibleRanges, (key) => {
        if (this.requested.has(key)) return;
        this.requested.add(key);
        onImageNeeded(key);
      });
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

// A plain click follows a link, as in the rendered view. The press is taken too,
// so it does not move the caret into the link on the way.
const linkClicks = EditorView.domEventHandlers({
  mousedown(event) {
    if (clickedLink(event) === null) return false;
    event.preventDefault();
    return true;
  },
  click(event, view) {
    const link = clickedLink(event);
    if (link === null) return false;
    event.preventDefault();
    view.state.facet(previewConfig).onOpenLink(link, event);
    return true;
  },
});

/** Draws the Markdown in place: the page stays rendered while it is edited. */
export function livePreview(config?: LivePreviewConfig): Extension {
  return [
    config ? previewConfig.of(config) : [],
    focusField,
    EditorView.focusChangeEffect.of((_state, focusing) => setFocused.of(focusing)),
    frontmatterField,
    imageUrlsField,
    detailsField,
    blockPreview,
    inlinePreview,
    linkClicks,
    EditorView.editorAttributes.of({ class: "cm-live-preview" }),
  ];
}
