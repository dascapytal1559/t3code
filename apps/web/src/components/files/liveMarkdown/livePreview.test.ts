import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { describe, expect, it } from "vite-plus/test";

import {
  blockDecorations,
  frontmatterField,
  inlineDecorations,
  livePreview,
  setFocused,
} from "./livePreview";
import { liveMarkdownExtensions } from "./markdownSyntax";

/** A focused editor on `text` with the caret where `|` is; without one the editor has no focus. */
function editorOn(text: string): EditorState {
  const caret = text.indexOf("|");
  const doc = caret < 0 ? text : text.replace("|", "");
  const state = EditorState.create({
    doc,
    selection: { anchor: Math.max(caret, 0) },
    extensions: [
      markdown({ base: markdownLanguage, extensions: [...liveMarkdownExtensions] }),
      livePreview(),
    ],
  });
  const focused = state.update({ effects: setFocused.of(caret >= 0) }).state;
  ensureSyntaxTree(focused, doc.length, 5000);
  return focused;
}

interface Drawn {
  /** Source text no longer shown as written: hidden, or swapped for a widget. */
  readonly replaced: string[];
  /** Source text shown dimmed, as syntax at the caret. */
  readonly dimmed: string[];
  readonly widgets: string[];
  readonly lineClasses: Record<number, string>;
}

function summarize(state: EditorState, set: DecorationSet, into: Drawn) {
  for (const cursor = set.iter(); cursor.value !== null; cursor.next()) {
    const spec = cursor.value.spec as {
      class?: string;
      widget?: { constructor: { name: string } };
    };
    const text = state.doc.sliceString(cursor.from, cursor.to);
    if (spec.widget) into.widgets.push(spec.widget.constructor.name);
    if (cursor.from === cursor.to && spec.class && !spec.widget) {
      const line = state.doc.lineAt(cursor.from).number;
      into.lineClasses[line] = [into.lineClasses[line], spec.class].filter(Boolean).join(" ");
    } else if (spec.class === "cm-lp-syntax") into.dimmed.push(text);
    else if (spec.class === undefined && cursor.to > cursor.from) into.replaced.push(text);
  }
}

function drawn(text: string): Drawn {
  const state = editorOn(text);
  const out: Drawn = { replaced: [], dimmed: [], widgets: [], lineClasses: {} };
  summarize(state, blockDecorations(state), out);
  summarize(state, inlineDecorations(state, [{ from: 0, to: state.doc.length }]), out);
  return out;
}

describe("live preview", () => {
  it("hides the marks of inline formatting away from the caret", () => {
    const view = drawn("# Title\n\nSome **bold**, *soft*, ~~gone~~ and `code` with a \\* star.");
    expect(view.replaced).toEqual(["# ", "**", "**", "*", "*", "~~", "~~", "`", "`", "\\"]);
    expect(view.dimmed).toEqual([]);
    expect(view.lineClasses[1]).toBe("cm-lp-h cm-lp-h1");
  });

  it("shows the marks, dimmed, of the piece the caret is in and of no other", () => {
    const view = drawn("Some **bo|ld** and *soft* text.");
    expect(view.dimmed).toEqual(["**", "**"]);
    expect(view.replaced).toEqual(["*", "*"]);
  });

  it("shows a heading's marks while the caret is on its line", () => {
    expect(drawn("## Tit|le").dimmed).toEqual(["##"]);
    expect(drawn("## Title\n\nBody|").replaced).toEqual(["## "]);
  });

  it("draws list markers as bullets, numbers and boxes, and keeps the raw marker at the caret", () => {
    const list = "- one\n  - nested\n1. first\n- [ ] open\n- [x] done";
    expect(drawn(list).widgets).toEqual([
      "BulletWidget",
      "BulletWidget",
      "OrderedWidget",
      "CheckboxWidget",
      "CheckboxWidget",
    ]);
    // A task has no bullet: its marker is hidden and the box stands in for it.
    expect(drawn("- [ ] open").replaced).toEqual(["- ", "[ ] "]);
    expect(drawn("|- one\n- two").widgets).toEqual(["BulletWidget"]);
  });

  it("hangs a list item's wrapped and continued lines under its text", () => {
    const view = drawn("- one\n  more\n  - nested");
    expect(view.lineClasses).toEqual({ 1: "cm-lp-li", 2: "cm-lp-li", 3: "cm-lp-li" });
  });

  it("draws a callout's first line as its title and a plain quote without one", () => {
    const callout = drawn("> [!WARNING] Mind the tide\n> It turns fast.");
    expect(callout.widgets).toEqual(["CalloutTitleWidget"]);
    expect(callout.lineClasses[2]).toBe("cm-lp-quote cm-lp-callout cm-lp-callout-warning");
    const quote = drawn("> Just a quote");
    expect(quote.widgets).toEqual([]);
    expect(quote.replaced).toEqual(["> "]);
  });

  it("frames a code block, labels its language, and shows the fences at the caret", () => {
    const code = "```ts\nconst a = 1;\n```";
    const closed = drawn(code);
    expect(closed.widgets).toEqual(["CodeLabelWidget"]);
    expect(closed.replaced).toEqual(["```ts", "```"]);
    expect(closed.lineClasses[2]).toBe("cm-lp-codeblock");
    const open = drawn("```ts\nconst a| = 1;\n```");
    expect(open.widgets).toEqual([]);
    expect(open.replaced).toEqual([]);
  });

  it("draws a rule, and shortens blank lines except inside code", () => {
    const view = drawn("a\n\n---\n\n```\n\n```");
    expect(view.widgets).toContain("RuleWidget");
    expect(view.lineClasses[2]).toBe("cm-lp-blank");
    expect(view.lineClasses[6]).toBe("cm-lp-codeblock");
  });

  it("swaps frontmatter for a card, and for its source while the caret is in it", () => {
    const file = "---\ntitle: Survey\n---\n\n# Body";
    const card = drawn(file);
    expect(card.widgets).toEqual(["FrontmatterWidget"]);
    // The grammar reads frontmatter as a rule and a heading; neither is drawn.
    expect(card.lineClasses[2]).toBeUndefined();
    const source = drawn("---\ntitle: Sur|vey\n---\n\n# Body");
    expect(source.widgets).toEqual([]);
    expect(source.lineClasses[2]).toBe("cm-lp-src-line");
  });

  it("tracks where frontmatter ends as the file is edited", () => {
    const state = editorOn("---\ntitle: Survey\n---\n\n# Body");
    expect(state.field(frontmatterField)).toBe(21);
    const longer = state.update({ changes: { from: 4, insert: "x" } }).state;
    expect(longer.field(frontmatterField)).toBe(22);
    const opened = longer.update({ changes: { from: 19, to: 22 } }).state;
    expect(opened.field(frontmatterField)).toBe(0);
  });

  it("draws everything while the editor has no focus", () => {
    const view = drawn("Some **bold** text.");
    expect(view.dimmed).toEqual([]);
    expect(view.replaced).toEqual(["**", "**"]);
  });
});
