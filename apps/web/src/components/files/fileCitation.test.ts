import { Text } from "@codemirror/state";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFileCitation,
  editorSelectionLines,
  renderedSelectionLines,
  splitSourceLines,
  type RenderedSelectionEnd,
} from "./fileCitation";

const environmentId = EnvironmentId.make("local");

describe("buildFileCitation", () => {
  it("quotes the text at the path and orders the lines", () => {
    expect(
      buildFileCitation({
        environmentId,
        path: "/repo/notes.md",
        lines: { startLine: 9, endLine: 4 },
        text: "Ship it.",
      }),
    ).toStrictEqual({
      environmentId,
      path: "/repo/notes.md",
      startLine: 4,
      endLine: 9,
      text: "Ship it.",
    });
  });

  it("refuses a blank selection", () => {
    expect(
      buildFileCitation({
        environmentId,
        path: "/repo/notes.md",
        lines: { startLine: 1, endLine: 1 },
        text: " \n\t",
      }),
    ).toBeNull();
  });
});

describe("editorSelectionLines", () => {
  const doc = Text.of(["# Title", "", "First line", "Second line", "Third line"]);
  const lineStart = (line: number) => doc.line(line).from;

  it.each([
    ["within one line", lineStart(3) + 2, lineStart(3) + 6, 3, 3],
    ["across lines", lineStart(3) + 2, lineStart(5) + 3, 3, 5],
    ["up to the next line's start", lineStart(3), lineStart(5), 3, 4],
    ["to the end of the file", lineStart(4), doc.length, 4, 5],
  ])("maps a selection %s", (_name, from, to, startLine, endLine) => {
    expect(editorSelectionLines(doc, from, to)).toStrictEqual({ startLine, endLine });
  });
});

describe("renderedSelectionLines", () => {
  const source = [
    "# Plan", //                                        1
    "", //                                              2
    "We ship the **beta** on Friday, after the", //     3
    "[review](https://example.com/review) and the", // 4
    "docs pass.", //                                    5
    "", //                                              6
    "- Fix the build", //                               7
    "- Write the notes", //                             8
  ].join("\n");
  const lines = splitSourceLines(source);
  const paragraph = {
    block: { startLine: 3, endLine: 5 },
    text: "We ship the beta on Friday, after the review and the docs pass.",
  };
  const at = (block: typeof paragraph, quote: string, end = false): RenderedSelectionEnd => {
    const index = block.text.indexOf(quote);
    return { ...block, offset: end ? index + quote.length : index };
  };

  it("places each end on the source line its words came from", () => {
    expect(
      renderedSelectionLines(lines, at(paragraph, "Friday"), at(paragraph, "review", true)),
    ).toStrictEqual({ startLine: 3, endLine: 4 });
    expect(
      renderedSelectionLines(lines, at(paragraph, "review"), at(paragraph, "docs", true)),
    ).toStrictEqual({ startLine: 4, endLine: 5 });
  });

  it("skips markup words in the source, such as a link's target", () => {
    const review = { block: { startLine: 4, endLine: 5 }, text: "review and the docs pass." };
    expect(
      renderedSelectionLines(lines, at(review, "the"), at(review, "pass", true)),
    ).toStrictEqual({ startLine: 4, endLine: 5 });
    const linked = splitSourceLines("See [setup](docs/setup.md)\nsetup takes <b>a</b> minute.");
    const setup = { block: { startLine: 1, endLine: 2 }, text: "See setup setup takes a minute." };
    expect(
      renderedSelectionLines(linked, at(setup, "setup takes"), at(setup, "minute", true)),
    ).toStrictEqual({ startLine: 2, endLine: 2 });
  });

  it("ends a selection at the boundary of the block it stops at, as a triple click leaves it", () => {
    const first = { block: { startLine: 7, endLine: 7 }, text: "Fix the build" };
    const second = { block: { startLine: 8, endLine: 8 }, text: "Write the notes" };
    expect(
      renderedSelectionLines(lines, at(paragraph, "We"), { ...first, offset: 0 }),
    ).toStrictEqual({ startLine: 3, endLine: 5 });
    expect(
      renderedSelectionLines(
        lines,
        { ...paragraph, offset: paragraph.text.length },
        at(second, "Write", true),
      ),
    ).toStrictEqual({ startLine: 7, endLine: 8 });
  });

  it("spans blocks, from one list item to another", () => {
    const first = { block: { startLine: 7, endLine: 7 }, text: "Fix the build" };
    const second = { block: { startLine: 8, endLine: 8 }, text: "Write the notes" };
    expect(
      renderedSelectionLines(lines, at(first, "build"), at(second, "Write", true)),
    ).toStrictEqual({ startLine: 7, endLine: 8 });
  });

  it("takes the whole block for an end it cannot place", () => {
    const rendered = { ...paragraph, text: "We ship the beta on Fri­day (rendered differently)." };
    expect(
      renderedSelectionLines(lines, at(rendered, "rendered"), at(rendered, "differently", true)),
    ).toStrictEqual({ startLine: 3, endLine: 5 });
  });

  it("takes the whole block for an end with no words, such as punctuation", () => {
    expect(
      renderedSelectionLines(
        lines,
        { ...paragraph, offset: paragraph.text.length - 1 },
        { ...paragraph, offset: paragraph.text.length },
      ),
    ).toStrictEqual({ startLine: 3, endLine: 5 });
  });
});
