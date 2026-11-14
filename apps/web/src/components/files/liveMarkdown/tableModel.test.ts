import { describe, expect, it } from "vite-plus/test";

import { type TableInline, tableModel } from "./tableModel";

const text = (value: string): TableInline => ({ kind: "text", text: value });

describe("tableModel", () => {
  it("reads the cells, their place in the source, and the column alignment", () => {
    const source = "| Station | Height |  Off |\n| :-- | --: | :-: |\n| 7 | 417 | +12 |";
    const model = tableModel(source);
    expect(model?.align).toEqual(["left", "right", "center"]);
    expect(model?.head.map((cell) => cell.content)).toEqual([
      [text("Station")],
      [text("Height")],
      [text("Off")],
    ]);
    expect(model?.rows).toHaveLength(1);
    // Each offset is where a click in that cell puts the caret.
    expect(model?.rows[0]?.map((cell) => source.slice(cell.offset, cell.offset + 3))).toEqual([
      "7 |",
      "417",
      "+12",
    ]);
  });

  it("keeps empty cells in their columns, with or without outer pipes", () => {
    expect(tableModel("| a | b | c |\n|---|---|---|\n| 1 |  | 3 |\n|  | 2 |")?.rows).toEqual([
      [
        { offset: 30, content: [text("1")] },
        { offset: 34, content: [] },
        { offset: 37, content: [text("3")] },
      ],
      [
        { offset: 43, content: [] },
        { offset: 46, content: [text("2")] },
      ],
    ]);
    expect(tableModel("a | b\n--|--\n1 | 2")?.rows[0]?.map((cell) => cell.content)).toEqual([
      [text("1")],
      [text("2")],
    ]);
  });

  it("keeps formatting as structure and drops its marks", () => {
    const model = tableModel(
      "| a |\n|---|\n| **bold** and *soft* ~~gone~~ `code \\| x` [site](https://t3.codes) a\\|b |",
    );
    expect(model?.rows[0]?.[0]?.content).toEqual([
      { kind: "strong", children: [text("bold")] },
      text(" and "),
      { kind: "emphasis", children: [text("soft")] },
      text(" "),
      { kind: "strike", children: [text("gone")] },
      text(" "),
      { kind: "code", text: "code \\| x" },
      text(" "),
      { kind: "link", href: "https://t3.codes", children: [text("site")] },
      text(" a|b"),
    ]);
  });

  it("is null for text that is not a table", () => {
    expect(tableModel("just | some | text")).toBeNull();
  });
});
