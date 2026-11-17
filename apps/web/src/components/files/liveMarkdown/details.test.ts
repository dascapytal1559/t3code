import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";

import { detailsBlocks, detailsField, setDetailsOpen, tagLineStep } from "./details";
import { externalChangeSpec } from "./externalChanges";
import { liveMarkdownExtensions } from "./markdownSyntax";

function stateOf(doc: string): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage, extensions: [...liveMarkdownExtensions] }),
      detailsField,
    ],
  });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

/** Each block as the text it folds, its summary, and whether it is open. */
function blocksOf(state: EditorState) {
  const { blocks, open } = state.field(detailsField);
  return blocks.map((block) => ({
    text: state.doc.sliceString(block.from, block.to),
    header: state.doc.sliceString(block.from, block.headerTo),
    summary: block.summary,
    open: open.has(block.from),
  }));
}

const REPORT = [
  "# Report",
  "",
  "<details>",
  "<summary>Decision 1: ship it</summary>",
  "",
  "We **ship** on Friday.",
  "",
  "</details>",
  "",
  "<details open>",
  "<summary>Decision 2</summary>",
  "",
  "Open from the start.",
  "",
  "</details>",
].join("\n");

describe("details blocks", () => {
  it("reads each block from its opening tag to its closing tag, with its summary", () => {
    const state = stateOf(REPORT);
    expect(blocksOf(state)).toEqual([
      {
        text: "<details>\n<summary>Decision 1: ship it</summary>\n\nWe **ship** on Friday.\n\n</details>",
        header: "<details>\n<summary>Decision 1: ship it</summary>",
        summary: "Decision 1: ship it",
        open: false,
      },
      {
        text: "<details open>\n<summary>Decision 2</summary>\n\nOpen from the start.\n\n</details>",
        header: "<details open>\n<summary>Decision 2</summary>",
        summary: "Decision 2",
        open: true,
      },
    ]);
  });

  it("reads a summary on the tag's line, across lines, with markup, or none at all", () => {
    const summaries = (doc: string) => detailsBlocks(stateOf(doc)).map((block) => block.summary);
    expect(summaries("<details><summary>Same line</summary>\n\nBody\n\n</details>")).toEqual([
      "Same line",
    ]);
    expect(
      summaries("<details>\n<summary>\n<b>Two</b> &amp; lines\n</summary>\n\nB\n\n</details>"),
    ).toEqual(["Two & lines"]);
    expect(summaries("<details>\n\nBody\n\n</details>")).toEqual(["Details"]);
  });

  it("finds nested blocks, and leaves unclosed ones and tags in code alone", () => {
    const nested = stateOf(
      "<details>\n<summary>Outer</summary>\n\n<details>\n<summary>Inner</summary>\n\nx\n\n</details>\n\n</details>",
    );
    expect(blocksOf(nested).map((block) => block.summary)).toEqual(["Outer", "Inner"]);
    expect(detailsBlocks(stateOf("<details>\n<summary>Never closed</summary>\n\nx"))).toEqual([]);
    expect(detailsBlocks(stateOf("```\n<details>\nx\n</details>\n```"))).toEqual([]);
    expect(detailsBlocks(stateOf("<details><summary>One line</summary>x</details>"))).toEqual([]);
  });

  it("opens and closes a block without touching the file", () => {
    const state = stateOf(REPORT);
    const first = detailsBlocks(state)[0]!;
    const opened = state.update({ effects: setDetailsOpen.of({ from: first.from, open: true }) });
    expect(opened.state.doc.toString()).toBe(REPORT);
    expect(blocksOf(opened.state).map((block) => block.open)).toEqual([true, true]);
    const closed = opened.state.update({
      effects: setDetailsOpen.of({ from: first.from, open: false }),
    });
    expect(blocksOf(closed.state).map((block) => block.open)).toEqual([false, true]);
  });

  it("keeps each block's state through edits above it", () => {
    const state = stateOf(REPORT);
    const edited = state.update({ changes: { from: 0, insert: "Intro\n\n" }, userEvent: "input" });
    expect(blocksOf(edited.state).map((block) => block.open)).toEqual([false, true]);
  });

  it("opens a folded block when the caret lands in its body", () => {
    const state = stateOf(REPORT);
    const inBody = REPORT.indexOf("Friday");
    const moved = state.update({ selection: { anchor: inBody } });
    expect(blocksOf(moved.state)[0]?.open).toBe(true);
  });

  it("stops Up and Down on the tag lines a widget draws over", () => {
    const state = stateOf(REPORT);
    /** The line Up or Down from `line` stops on, or null where the usual move applies. */
    const step = (line: number, forward: boolean) => {
      const caret = state.update({ selection: { anchor: state.doc.line(line).from } }).state;
      const target = tagLineStep(caret, forward);
      return target === null ? null : caret.doc.lineAt(target).number;
    };
    // The folded block from above and below.
    expect(step(2, true)).toBe(3);
    expect(step(9, false)).toBe(8);
    // The open block's opening tag, summary line and closing tag.
    expect(step(9, true)).toBe(10);
    expect(step(12, false)).toBe(11);
    expect(step(14, true)).toBe(15);
    expect(step(1, true)).toBeNull();
    expect(step(13, true)).toBeNull();
  });

  it("keeps a block being typed open, and folds one written to disk", () => {
    const block = "\n\n<details>\n<summary>New</summary>\n\nBody\n\n</details>";
    const end = REPORT.length;
    const typed = stateOf(REPORT).update({
      changes: { from: end, insert: block },
      userEvent: "input.paste",
    });
    expect(blocksOf(typed.state)[2]).toMatchObject({ summary: "New", open: true });
    const fromDisk = stateOf(REPORT);
    const written = fromDisk.update(
      externalChangeSpec(fromDisk, [{ from: end, to: end, insert: block }]),
    );
    expect(blocksOf(written.state)[2]).toMatchObject({ summary: "New", open: false });
  });
});
