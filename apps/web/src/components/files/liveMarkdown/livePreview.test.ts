import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { openSearchPanel } from "@codemirror/search";
import { EditorState, StateEffect, type TransactionSpec } from "@codemirror/state";
import type { DecorationSet, EditorView } from "@codemirror/view";
import { describe, expect, it } from "vite-plus/test";

import {
  blockDecorations,
  frontmatterField,
  inlineDecorations,
  livePreview,
  setFocused,
  setImageUrls,
} from "./livePreview";
import { findReplace } from "./findReplace";
import { imageEmbedOf, liveMarkdownExtensions } from "./markdownSyntax";
import { ImageWidget } from "./widgets";

/** Web addresses load as they are; anything else is a file the app must sign a URL for. */
const resolveImage = (source: string) =>
  source.startsWith("https:")
    ? ({ kind: "url", url: source } as const)
    : ({ kind: "asset", key: source } as const);

/**
 * A focused editor on `text` with the caret where `marker` is; without one the
 * editor has no focus. Tables are full of `|`, so their tests mark the caret with `^`.
 */
function editorOn(text: string, marker = "|"): EditorState {
  const caret = text.indexOf(marker);
  const doc = caret < 0 ? text : text.replace(marker, "");
  const state = EditorState.create({
    doc,
    selection: { anchor: Math.max(caret, 0) },
    extensions: [
      markdown({ base: markdownLanguage, extensions: [...liveMarkdownExtensions] }),
      livePreview({
        resolveImage,
        resolveImageEmbed: (target) => ({ kind: "asset", key: `embed:${target}` }),
        onImageNeeded: () => {},
        onOpenLink: () => {},
      }),
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
  /** Text drawn as a link, with the address a click opens. */
  readonly links: Array<readonly [text: string, href: string]>;
  /** The address each drawn image loads, null while it has none. */
  readonly images: Array<string | null>;
}

function summarize(state: EditorState, set: DecorationSet, into: Drawn) {
  for (const cursor = set.iter(); cursor.value !== null; cursor.next()) {
    const spec = cursor.value.spec as {
      class?: string;
      attributes?: Record<string, string>;
      widget?: { constructor: { name: string } };
    };
    const text = state.doc.sliceString(cursor.from, cursor.to);
    if (spec.widget) into.widgets.push(spec.widget.constructor.name);
    if (spec.widget instanceof ImageWidget) into.images.push(spec.widget.url);
    const href = spec.attributes?.["data-href"];
    if (href !== undefined) into.links.push([text, href]);
    if (cursor.from === cursor.to && spec.class && !spec.widget) {
      const line = state.doc.lineAt(cursor.from).number;
      into.lineClasses[line] = [into.lineClasses[line], spec.class].filter(Boolean).join(" ");
    } else if (spec.class === "cm-lp-syntax") into.dimmed.push(text);
    else if (spec.class === undefined && cursor.to > cursor.from) into.replaced.push(text);
  }
}

function drawn(text: string, marker?: string): Drawn {
  const state = editorOn(text, marker);
  const out: Drawn = {
    replaced: [],
    dimmed: [],
    widgets: [],
    lineClasses: {},
    links: [],
    images: [],
  };
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

  it("reads a leading rule closed by another as Markdown, not as empty frontmatter", () => {
    const file = "---\n\n# Intro\n\nText\n\n---\n\nMore";
    expect(editorOn(file).field(frontmatterField)).toBe(0);
    const view = drawn(file);
    expect(view.widgets).toEqual(["RuleWidget", "RuleWidget"]);
    expect(view.lineClasses[3]).toBe("cm-lp-h cm-lp-h1");
  });

  it("hides keyless frontmatter as the rendered view does, with no empty card", () => {
    const view = drawn("---\nfoo\n---\n\n# Body");
    expect(view.widgets).toEqual([]);
    expect(view.replaced).toEqual(["---\nfoo\n---", "# "]);
    expect(view.lineClasses[2]).toBeUndefined();
  });

  it("draws everything while the editor has no focus", () => {
    const view = drawn("Some **bold** text.");
    expect(view.dimmed).toEqual([]);
    expect(view.replaced).toEqual(["**", "**"]);
  });

  it("draws a link as its text, and shows its address only at the caret", () => {
    const link = "See the [season plan](../notes/plan.md) today.";
    const away = drawn(link);
    expect(away.links).toEqual([["season plan", "../notes/plan.md"]]);
    expect(away.replaced).toEqual(["[", "](../notes/plan.md)"]);
    const at = drawn("See the [season| plan](../notes/plan.md) today.");
    expect(at.links).toEqual([["season plan", "../notes/plan.md"]]);
    expect(at.dimmed).toEqual(["[", "](../notes/plan.md)"]);
  });

  it("makes bare addresses and autolinks clickable, and leaves reference links as written", () => {
    const view = drawn("Go to https://t3.codes or <https://example.com>, not [here][ref].");
    expect(view.links).toEqual([
      ["https://t3.codes", "https://t3.codes"],
      ["https://example.com", "https://example.com"],
    ]);
    expect(view.replaced).toEqual(["<", ">"]);
  });

  it("draws a wiki-link as its name or its label, with no address to open yet", () => {
    const view = drawn("See [[station-7]] and [[station-7|the log]].", "^");
    expect(view.replaced).toEqual(["[[", "]]", "[[station-7|", "]]"]);
    expect(view.links).toEqual([]);
  });

  it("steps aside for a bracketed citation, which keeps its address clickable", () => {
    const view = drawn("See [[1]](https://example.com).");
    expect(view.replaced).toEqual([]);
    expect(view.links).toEqual([["https://example.com", "https://example.com"]]);
  });

  it("draws an image in place of its Markdown, and after it while the caret is on its line", () => {
    const away = drawn("![Chart](https://t3.codes/chart.png)");
    expect(away.images).toEqual(["https://t3.codes/chart.png"]);
    expect(away.replaced).toEqual(["![Chart](https://t3.codes/chart.png)"]);
    const at = drawn("![Chart](https://t3.codes/chart.png)|");
    expect(at.images).toEqual(["https://t3.codes/chart.png"]);
    expect(at.dimmed).toEqual(["![Chart](https://t3.codes/chart.png)"]);
  });

  it("shows an image or a link address that spans lines as its source, hiding no line break", () => {
    const image = drawn("![a picture of\nthe station](https://t3.codes/station.png)");
    expect(image.images).toEqual(["https://t3.codes/station.png"]);
    expect(image.replaced).toEqual([]);
    expect(image.dimmed).toEqual(["![a picture of\nthe station](https://t3.codes/station.png)"]);
    const link = drawn('[x](https://a.b "first\nsecond")');
    expect(link.replaced).toEqual(["["]);
    expect(link.dimmed).toEqual(['](https://a.b "first\nsecond")']);
  });

  it("names the image files that need a URL, and draws each once it has one", () => {
    const state = editorOn("![Chart](media/chart.svg)");
    const whole = [{ from: 0, to: state.doc.length }];
    const needed: string[] = [];
    const waiting: Drawn = { ...drawn(""), images: [] };
    summarize(
      state,
      inlineDecorations(state, whole, (key) => needed.push(key)),
      waiting,
    );
    expect(needed).toEqual(["media/chart.svg"]);
    expect(waiting.images).toEqual([null]);

    const signed = state.update({
      effects: setImageUrls.of(new Map([["media/chart.svg", "/assets/signed"]])),
    }).state;
    const loaded: Drawn = { ...drawn(""), images: [] };
    summarize(signed, inlineDecorations(signed, whole), loaded);
    expect(loaded.images).toEqual(["/assets/signed"]);
  });

  it("draws an Obsidian picture embed once its file is found, and its source until then", () => {
    const text = "![[Pasted image 1.png|300]] and ![[station-7]]";
    const state = editorOn(text, "^");
    const whole = [{ from: 0, to: state.doc.length }];
    const needed: string[] = [];
    const waiting: Drawn = { ...drawn(""), images: [] };
    summarize(
      state,
      inlineDecorations(state, whole, (key) => needed.push(key)),
      waiting,
    );
    // An embedded note is not a picture and is never asked for.
    expect(needed).toEqual(["embed:Pasted image 1.png"]);
    expect(waiting.images).toEqual([]);
    expect(waiting.replaced).toEqual([]);

    const found = state.update({
      effects: setImageUrls.of(new Map([["embed:Pasted image 1.png", "/assets/signed"]])),
    }).state;
    const loaded: Drawn = { ...drawn(""), images: [] };
    summarize(found, inlineDecorations(found, whole), loaded);
    expect(loaded.images).toEqual(["/assets/signed"]);
    expect(loaded.replaced).toEqual(["![[Pasted image 1.png|300]]"]);

    const caret = editorOn(`${text}^`, "^");
    const atCaret = caret.update({
      effects: setImageUrls.of(new Map([["embed:Pasted image 1.png", "/assets/signed"]])),
    }).state;
    const editing: Drawn = { ...drawn(""), images: [] };
    summarize(atCaret, inlineDecorations(atCaret, whole), editing);
    expect(editing.images).toEqual(["/assets/signed"]);
    expect(editing.dimmed).toContain("![[Pasted image 1.png|300]]");
  });

  it.each([
    ["a.png", { target: "a.png", alt: "a.png", width: null, height: null }],
    ["media/a.JPG|300", { target: "media/a.JPG", alt: "media/a.JPG", width: 300, height: null }],
    ["a.webp|300x200", { target: "a.webp", alt: "a.webp", width: 300, height: 200 }],
    ["a.svg|the map", { target: "a.svg", alt: "the map", width: null, height: null }],
    ["a.gif|the map|120", { target: "a.gif", alt: "the map", width: 120, height: null }],
    ["a.png#section", { target: "a.png", alt: "a.png", width: null, height: null }],
    ["notes", null],
    ["clip.mp4", null],
  ])("reads the embed ![[%s]]", (inner, expected) => {
    expect(imageEmbedOf(inner)).toEqual(expected);
  });

  it("draws a table as a table, and as its source while the caret is in it", () => {
    const table = "Before\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter";
    const away = drawn(table, "^");
    expect(away.widgets).toEqual(["TableWidget"]);
    expect(away.replaced).toEqual(["| a | b |\n|---|---|\n| 1 | 2 |"]);
    const at = drawn("Before\n\n| a | b |\n|---|---|\n| 1 ^| 2 |\n\nAfter", "^");
    expect(at.widgets).toEqual([]);
    expect(at.lineClasses[5]).toBe("cm-lp-src-line");
  });

  it("opens a drawn table that find steps into while the find bar has the focus", () => {
    let state = editorOn("Before\n\n| a | b |\n|---|---|\n| 417 | 2 |\n\nAfter", "^");
    state = state.update({ effects: StateEffect.appendConfig.of(findReplace) }).state;
    // Opening the find bar reads and writes only the state.
    const findBar = {
      get state() {
        return state;
      },
      dispatch: (spec: TransactionSpec) => {
        state = state.update(spec).state;
      },
    };
    openSearchPanel(findBar as unknown as EditorView);
    const tables = () => {
      const view: Drawn = { ...drawn(""), widgets: [] };
      summarize(state, blockDecorations(state), view);
      return view.widgets;
    };
    expect(tables()).toEqual(["TableWidget"]);
    const match = state.doc.toString().indexOf("417");
    state = state.update({ selection: { anchor: match, head: match + 3 } }).state;
    expect(tables()).toEqual([]);
  });

  it("leaves a table inside a list as its source", () => {
    const view = drawn("- item\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |", "^");
    expect(view.widgets).toEqual(["BulletWidget"]);
    expect(view.lineClasses[3]).toContain("cm-lp-src-line");
  });
});
