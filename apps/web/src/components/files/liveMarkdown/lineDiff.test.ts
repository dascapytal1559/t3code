import { describe, expect, it } from "vite-plus/test";

import { lineChanges, type TextChange } from "./lineDiff";

function apply(text: string, changes: readonly TextChange[]): string {
  let out = "";
  let at = 0;
  for (const change of changes) {
    out += text.slice(at, change.from) + change.insert;
    at = change.to;
  }
  return out + text.slice(at);
}

describe("lineChanges", () => {
  it.each([
    ["one line edited in the middle", "a\nb\nc", "a\nB\nc", 1],
    ["two separate edits", "a\nb\nc\nd\ne", "a\nB\nc\nd\nE", 2],
    ["a line added at the end", "a\nb", "a\nb\nc", 1],
    ["the last line removed", "a\nb\nc", "a\nb", 1],
    ["a line added at the start", "b\nc", "a\nb\nc", 1],
    ["a trailing line break added", "a\nb", "a\nb\n", 1],
    ["a trailing line break removed", "a\nb\n", "a\nb", 1],
    ["everything replaced", "a\nb", "x\ny\nz", 1],
    ["an empty file filled", "", "a\nb", 1],
    ["a file emptied", "a\nb", "", 1],
    ["repeated lines with one removed", "x\nx\nx\ny", "x\nx\ny", 1],
    ["a block moved", "a\nb\nc\nd", "c\nd\na\nb", 2],
    ["no change", "a\nb", "a\nb", 0],
  ])("turns the old text into the new one: %s", (_name, current, next, count) => {
    const changes = lineChanges(current, next);
    expect(apply(current, changes)).toBe(next);
    expect(changes).toHaveLength(count);
  });

  it("leaves the lines between two edits out of every change", () => {
    const current = "one\ntwo\nthree\nfour\nfive";
    const changes = lineChanges(current, "ONE\ntwo\nthree\nfour\nFIVE");
    const kept = current.indexOf("two");
    for (const change of changes) {
      expect(change.to <= kept || change.from >= current.indexOf("\nfive")).toBe(true);
    }
  });

  it("falls back to one change when too many lines differ", () => {
    const current = Array.from({ length: 800 }, (_, index) => `old ${index}`).join("\n");
    const next = Array.from({ length: 800 }, (_, index) => `new ${index}`).join("\n");
    const changes = lineChanges(`head\n${current}\ntail`, `head\n${next}\ntail`);
    expect(changes).toHaveLength(1);
    expect(apply(`head\n${current}\ntail`, changes)).toBe(`head\n${next}\ntail`);
  });
});
