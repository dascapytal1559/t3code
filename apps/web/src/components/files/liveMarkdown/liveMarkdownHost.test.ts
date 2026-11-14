import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { imageAssetResource, imageSourceOf, linkUrlOf } from "./liveMarkdownHost";

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
