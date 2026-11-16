import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  findImageEmbed,
  type ImageEmbedLookup,
  imageAssetResource,
  imageSourceOf,
  linkUrlOf,
} from "./liveMarkdownHost";

describe("where a file's images load from", () => {
  it.each([
    ["https://t3.codes/a.png", { kind: "url", url: "https://t3.codes/a.png" }],
    ["media/chart.svg", { kind: "asset", key: "relative:/work/reports/media/chart.svg" }],
    ["/elsewhere/shot.png", { kind: "asset", key: "absolute:/elsewhere/shot.png" }],
    // Video and audio in image syntax are not drawn in the editor.
    ["clip.mp4", { kind: "blocked" }],
    ["javascript:alert(1)", { kind: "blocked" }],
  ])("loads %s as %j", (source, expected) => {
    expect(imageSourceOf(source, "/work/reports")).toEqual(expected);
  });

  it("asks the server for the image file, and only on the host for a relative one", () => {
    const threadId = ThreadId.make("thread");
    expect(imageAssetResource("relative:/work/a b.png", threadId)).toEqual({
      _tag: "media-file",
      threadId,
      path: "/work/a b.png",
      hostOnly: true,
    });
    expect(imageAssetResource("absolute:/c:/x.png", threadId)).toEqual({
      _tag: "media-file",
      threadId,
      path: "/c:/x.png",
    });
  });
});

describe("which file an Obsidian picture embed shows", () => {
  /** A project at /work whose files are `files`; the search sees only `indexed`. */
  function project(files: readonly string[], indexed = files) {
    return {
      files: async (paths: readonly string[]) =>
        paths.map((path) => files.includes(path.slice("/work/".length))),
      search: async (name: string) =>
        indexed
          .filter((path) => path.toLowerCase().includes(name.toLowerCase()))
          .map((path) => ({ path, kind: "file" as const })),
    } satisfies ImageEmbedLookup;
  }
  const find = (target: string, lookup: ImageEmbedLookup) =>
    findImageEmbed(target, "/work/notes/daily", "/work", lookup);

  it.each([
    // The path from the note's folder wins over the same name anywhere else.
    [
      "media/a.png",
      ["notes/daily/media/a.png", "notes/daily/a.png", "media/a.png"],
      "/work/notes/daily/media/a.png",
    ],
    // Then the bare name in the note's own folder.
    ["media/a.png", ["notes/daily/a.png", "media/a.png"], "/work/notes/daily/a.png"],
    // Then the path from the project root.
    ["media/a.png", ["media/a.png", "x/media/a.png"], "/work/media/a.png"],
    // Then the shortest project path that ends in it, its case aside.
    ["A.png", ["deep/er/a.png", "img/a.png", "img/ba.png"], "/work/img/a.png"],
    ["media/a.png", ["x/y/media/a.png", "z/media/a.png"], "/work/z/media/a.png"],
  ])("finds %s among %j at %s", async (target, files, expected) => {
    expect(await find(target, project(files))).toBe(expected);
  });

  it("finds a picture beside the note in a gitignored folder, which the search never sees", async () => {
    const lookup = project(["notes/daily/Pasted image 1.png"], []);
    expect(await find("Pasted image 1.png", lookup)).toBe("/work/notes/daily/Pasted image 1.png");
  });

  it("finds nothing for a name no file has, or when files cannot be told apart", async () => {
    expect(await find("gone.png", project(["img/here.png"]))).toBeNull();
    const unreadable: ImageEmbedLookup = {
      files: async () => null,
      search: async () => [{ path: "gone.png", kind: "file" }],
    };
    expect(await find("gone.png", unreadable)).toBeNull();
  });
});

describe("what an autolink opens", () => {
  it.each([
    ["www.example.com/a", "https://www.example.com/a"],
    ["me@example.com", "mailto:me@example.com"],
    ["https://example.com", "https://example.com"],
    ["mailto:me@example.com", "mailto:me@example.com"],
  ])("%s opens %s", (href, url) => {
    expect(linkUrlOf(href)).toBe(url);
  });
});
