import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { indentUnit, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { drawSelection, dropCursor, EditorView, keymap } from "@codemirror/view";
import { markdownFrontmatterLength } from "@t3tools/shared/markdownFrontmatter";

import { codeHighlightStyle, codeLanguages } from "./codeLanguages";
import { externalChange, externalChangeSpec, flashSpans, lineFlash } from "./externalChanges";
import { listKeymap } from "./formatting";
import { lineChanges } from "./lineDiff";
import { fromEditorText, type LineEnding, lineEndingOf, toEditorText } from "./lineEndings";
import { livePreview, setImageUrls } from "./livePreview";
import { liveMarkdownExtensions } from "./markdownSyntax";
import type { LivePreviewConfig } from "./previewConfig";

// A mixed file names its separator, which keeps its carriage returns as text.
const separatorFor = (ending: LineEnding): Extension =>
  ending === "mixed" ? EditorState.lineSeparator.of("\n") : [];

export interface LiveMarkdownEditorOptions extends LivePreviewConfig {
  readonly parent: HTMLElement;
  readonly doc: string;
  /** Called with the file's new text after each edit made in the editor. */
  readonly onChange: (text: string) => void;
}

export interface LiveMarkdownEditor {
  readonly view: EditorView;
  /** The file's text, with the line endings it was opened with. */
  readonly text: () => string;
  /** Takes contents that changed outside the editor; the caret, scroll and undo history stay. */
  readonly applyExternal: (next: string) => void;
  readonly setImageUrls: (urls: ReadonlyMap<string, string>) => void;
  /** Scrolls to a 1-based line of the file, puts the caret there and tints it for a moment. */
  readonly revealLine: (line: number) => void;
  readonly destroy: () => void;
}

export function createLiveMarkdownEditor(options: LiveMarkdownEditorOptions): LiveMarkdownEditor {
  let ending = lineEndingOf(options.doc);
  const separator = new Compartment();
  const text = () => fromEditorText(view.state.doc.toString(), ending);

  // One entry per feature: a new behaviour is a new file added to this list.
  const extensions: Extension[] = [
    separator.of(separatorFor(ending)),
    history(),
    drawSelection(),
    dropCursor(),
    EditorView.lineWrapping,
    indentUnit.of("  "),
    markdown({
      base: markdownLanguage,
      codeLanguages: [...codeLanguages],
      extensions: [...liveMarkdownExtensions],
    }),
    syntaxHighlighting(codeHighlightStyle),
    livePreview(options),
    lineFlash,
    keymap.of([...listKeymap, ...historyKeymap, ...defaultKeymap]),
    EditorView.contentAttributes.of({
      spellcheck: "true",
      "aria-label": "File contents",
      // Opening a file from the tree focuses this, as it does the source editor.
      "data-file-content-focus": "",
    }),
    // Workspace focus scrolls its target fully into view. For an editor taller than its
    // scroller that means the bottom of the file, so the scroll position is put back.
    EditorView.domEventHandlers({
      focus(_event, focused) {
        const top = focused.scrollDOM.scrollTop;
        queueMicrotask(() => {
          if (focused.scrollDOM.scrollTop !== top) focused.scrollDOM.scrollTop = top;
        });
      },
    }),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      if (update.transactions.every((tr) => tr.annotation(externalChange) === true)) return;
      options.onChange(text());
    }),
  ];

  const doc = toEditorText(options.doc, ending);
  // The caret starts below the frontmatter, which would otherwise open as its source.
  const frontmatter = markdownFrontmatterLength(doc);
  const view = new EditorView({
    parent: options.parent,
    state: EditorState.create({
      doc,
      selection: { anchor: frontmatter > 0 ? Math.min(frontmatter + 1, doc.length) : 0 },
      extensions,
    }),
  });

  return {
    view,
    text,
    applyExternal(next) {
      const nextEnding = lineEndingOf(next);
      const incoming = toEditorText(next, nextEnding);
      const current = view.state.doc.toString();
      if (nextEnding === ending && incoming === current) return;
      if (nextEnding === ending) {
        view.dispatch(externalChangeSpec(view.state, lineChanges(current, incoming)));
        return;
      }
      // The file changed its line endings: take it whole, under its new separator.
      ending = nextEnding;
      view.dispatch(
        externalChangeSpec(
          view.state,
          [{ from: 0, to: current.length, insert: incoming }],
          [separator.reconfigure(separatorFor(ending))],
        ),
      );
    },
    setImageUrls: (urls) => view.dispatch({ effects: setImageUrls.of(urls) }),
    revealLine(number) {
      const line = view.state.doc.line(Math.min(Math.max(1, number), view.state.doc.lines));
      view.dispatch({
        selection: { anchor: line.from },
        effects: [
          EditorView.scrollIntoView(line.from, { y: "center" }),
          flashSpans([{ from: line.from, to: line.to }]),
        ],
      });
    },
    destroy: () => view.destroy(),
  };
}
