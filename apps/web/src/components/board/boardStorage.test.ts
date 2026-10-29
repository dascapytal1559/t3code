import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { describe, expect, it, vi } from "vite-plus/test";

import { type BoardSnapshot, createBoardSaver } from "./boardStorage";

// The saver only reads id, version and isDeleted, so fixtures carry just those.
function element(id: string, version: number) {
  return { id, version, isDeleted: false, type: "rectangle" } as unknown as ExcalidrawElement;
}

const viewport = { scrollX: 0, scrollY: 0, zoom: { value: 1 } } as const;

describe("createBoardSaver", () => {
  it("saves only edits after the loaded board, and flushes the last reported scene", () => {
    const save = vi.fn<(snapshot: BoardSnapshot) => void>();
    const saver = createBoardSaver(save, 60_000);

    saver.change([element("loaded", 1)], viewport, {});
    saver.flush();
    expect(save).not.toHaveBeenCalled();

    saver.change([element("loaded", 1), element("arrow", 3)], viewport, {});
    // Unmount flushes after Excalidraw has emptied its scene; nothing reported that empty scene.
    saver.flush();
    saver.flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0].elements.map(({ id }) => id)).toEqual(["loaded", "arrow"]);

    saver.change([element("loaded", 1), element("arrow", 3)], viewport, {});
    saver.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });
});
