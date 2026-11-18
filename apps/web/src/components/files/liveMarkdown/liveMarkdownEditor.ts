import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { foldedRanges, indentUnit, syntaxHighlighting, unfoldEffect } from "@codemirror/language";
import { EditorState, type Extension, type StateEffect } from "@codemirror/state";
import { drawSelection, dropCursor, EditorView, keymap } from "@codemirror/view";

import { codeHighlightStyle, codeLanguages } from "./codeLanguages";
import { type EditorHeading, headingsOf, mapHeadings } from "./editorOutline";
import { externalChange, externalChangeSpec, flashSpans, lineFlash } from "./externalChanges";
import { findReplace } from "./findReplace";
import { folding } from "./folding";
import { formatKeymap, listKeymap } from "./formatting";
import { lineChanges } from "./lineDiff";
import { fromEditorText, lineEndingOf, toEditorText } from "./lineEndings";
import { frontmatterField, livePreview, setImageUrls } from "./livePreview";
import { liveMarkdownExtensions } from "./markdownSyntax";
import { headingAnchors, type MarkdownOutlineSource } from "./outline";
import { NO_OUTLINE, type OutlineSnapshot, outlineTracker } from "./outlineTracker";
import type { LivePreviewConfig } from "./previewConfig";
import { msg } from "gt-react";
import { m } from "~/i18n/messages";

export interface LiveMarkdownEditorOptions extends LivePreviewConfig {
  readonly parent: HTMLElement;
  readonly doc: string;
  /** Called with the file's new text after each edit made in the editor. */
  readonly onChange: (text: string) => void;
}

export interface LiveMarkdownEditor {
  readonly view: EditorView;
  /** The file's text, with its own line endings. */
  readonly text: () => string;
  /** Takes contents that changed outside the editor; the caret, scroll and undo history stay. */
  readonly applyExternal: (next: string) => void;
  readonly setImageUrls: (urls: ReadonlyMap<string, string>) => void;
  /** Scrolls to a 1-based line of the file, puts the caret there and tints it for a moment. */
  readonly revealLine: (line: number) => void;
  /** The file's headings for the outline menu; a jump goes to one it listed. */
  readonly outline: MarkdownOutlineSource;
  /** Scrolls to the heading at that place in `outlineSnapshot`. */
  readonly jumpToHeading: (index: number) => void;
  /** The headings and the section being read, for the pinned outline; the same object until either changes. */
  readonly outlineSnapshot: () => OutlineSnapshot;
  /** Calls back when `outlineSnapshot` changes, until the returned function is called. */
  readonly watchOutline: (listener: () => void) => () => void;
  /** Scrolls to the heading a `#link` names. False when the file has no such heading. */
  readonly jumpToAnchor: (anchor: string) => boolean;
  readonly destroy: () => void;
}

export function createLiveMarkdownEditor(options: LiveMarkdownEditorOptions): LiveMarkdownEditor {
  let ending = lineEndingOf(options.doc);
  const text = () => fromEditorText(view.state.doc.toString(), ending);
  let listed: readonly EditorHeading[] = [];

  // One entry per feature: a new behaviour is a new file added to this list.
  const extensions: Extension[] = [
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
    outlineTracker,
    folding,
    findReplace,
    keymap.of([...formatKeymap, ...listKeymap, ...historyKeymap, ...defaultKeymap]),
    EditorView.contentAttributes.of({
      spellcheck: "true",
      "aria-label": m(msg("File contents")),
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
      listed = mapHeadings(listed, update.changes);
      if (update.transactions.every((tr) => tr.annotation(externalChange) === true)) return;
      options.onChange(text());
    }),
  ];

  const doc = toEditorText(options.doc);
  const opened = EditorState.create({ doc, extensions });
  // The caret starts below the frontmatter, which would otherwise open as its source.
  const frontmatter = opened.field(frontmatterField);
  const view = new EditorView({
    parent: options.parent,
    state:
      frontmatter > 0
        ? opened.update({ selection: { anchor: Math.min(frontmatter + 1, doc.length) } }).state
        : opened,
  });

  const showHeading = (heading: EditorHeading | undefined) => {
    if (!heading) return false;
    const line = view.state.doc.lineAt(heading.from);
    // A heading folded away inside another section is opened up first.
    const unfold: StateEffect<unknown>[] = [];
    foldedRanges(view.state).between(line.from, line.to, (from, to) => {
      if (from < line.from) unfold.push(unfoldEffect.of({ from, to }));
    });
    view.dispatch({
      selection: { anchor: line.to },
      effects: [
        ...unfold,
        EditorView.scrollIntoView(line.from, { y: "start", yMargin: 12 }),
        flashSpans([{ from: line.from, to: line.to }]),
      ],
    });
    return true;
  };

  return {
    view,
    text,
    outline: {
      headings: () => (listed = headingsOf(view.state)),
      jump: (index) => void showHeading(listed[index]),
    },
    jumpToHeading: (index) => void showHeading(view.plugin(outlineTracker)?.headingAt(index)),
    // A destroyed editor has no plugins left.
    outlineSnapshot: () => view.plugin(outlineTracker)?.current() ?? NO_OUTLINE,
    watchOutline: (listener) => view.plugin(outlineTracker)?.subscribe(listener) ?? (() => {}),
    jumpToAnchor(anchor) {
      const headings = headingsOf(view.state);
      return showHeading(headings[headingAnchors(headings).indexOf(anchor.toLowerCase())]);
    },
    applyExternal(next) {
      ending = lineEndingOf(next, ending);
      const incoming = toEditorText(next);
      const current = view.state.doc.toString();
      if (incoming === current) return;
      view.dispatch(externalChangeSpec(view.state, lineChanges(current, incoming)));
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
