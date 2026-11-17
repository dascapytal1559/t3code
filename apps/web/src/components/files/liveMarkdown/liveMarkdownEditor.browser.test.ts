import { describe, expect, it } from "vite-plus/test";

import { createLiveMarkdownEditor } from "./liveMarkdownEditor";

describe("createLiveMarkdownEditor", () => {
  it("hands the pinned outline its snapshot without running the editor's plugins", () => {
    const host = document.createElement("div");
    host.style.height = "300px";
    document.body.append(host);
    const resolved: string[] = [];
    const editor = createLiveMarkdownEditor({
      parent: host,
      doc: `![chart](chart.png)\n\n${"A line of the note.\n\n".repeat(400)}`,
      onChange: () => {},
      resolveImage: (source) => {
        resolved.push(source);
        return { kind: "asset", key: source };
      },
      resolveImageEmbed: () => ({ kind: "blocked" }),
      onImageNeeded: () => {},
      onOpenLink: () => {},
      inlineCodeLink: () => null,
      bareLinks: () => [],
    });
    try {
      const stop = editor.watchOutline(() => {});
      const before = resolved.length;
      // React reads the snapshot while it renders, when the app's callbacks must not run.
      editor.outlineSnapshot();
      expect(resolved.length).toBe(before);
      stop();
    } finally {
      editor.destroy();
      host.remove();
    }
  });
});
