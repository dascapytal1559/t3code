import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";

import { headingsOf } from "./editorOutline";
import { livePreview } from "./livePreview";
import { liveMarkdownExtensions } from "./markdownSyntax";
import { headingAnchors } from "./outline";

function outlineOf(doc: string): string[] {
  const state = EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage, extensions: [...liveMarkdownExtensions] }),
      livePreview(),
    ],
  });
  return headingsOf(state).map(
    ({ level, text, from }) => `${"#".repeat(level)} ${text} @${state.doc.lineAt(from).number}`,
  );
}

describe("the editor's outline", () => {
  it("lists the headings as they read, without marks or link addresses", () => {
    const doc = [
      "# One *two* `three`",
      "",
      "Text",
      "",
      "## [Linked](https://t3.codes) title ##",
      "",
      "Underlined",
      "----------",
      "",
      "> ### Quoted",
      "",
      "```",
      "# a comment in code",
      "```",
    ].join("\n");
    expect(outlineOf(doc)).toEqual([
      "# One two three @1",
      "## Linked title @5",
      "## Underlined @7",
      "### Quoted @10",
    ]);
  });

  it("leaves out the heading the grammar sees at the end of frontmatter", () => {
    expect(outlineOf("---\ntitle: Survey\n---\n\n# Body")).toEqual(["# Body @5"]);
  });

  it("gives each heading the anchor a #link names", () => {
    const headings = ["Next steps", "Q&A: what's left?", "Next steps"].map((text) => ({
      level: 2,
      text,
    }));
    expect(headingAnchors(headings)).toEqual(["next-steps", "qa-whats-left", "next-steps-1"]);
  });
});
