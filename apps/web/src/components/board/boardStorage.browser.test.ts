import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData, BinaryFiles } from "@excalidraw/excalidraw/types";
import { describe, expect, it } from "vite-plus/test";

import { clearBoard, loadBoard, saveBoard, toBoardSnapshot } from "./boardStorage";

// Storage only reads id, type, isDeleted and fileId, so fixtures carry just those.
function element(fields: { id: string; type: string; fileId?: string; isDeleted?: boolean }) {
  return { isDeleted: false, fileId: null, ...fields } as unknown as ExcalidrawElement;
}

function file(id: string) {
  return {
    id,
    dataURL: `data:image/png;base64,${id}`,
    mimeType: "image/png",
    created: 1,
  } as BinaryFileData;
}

describe("board storage", () => {
  it("keeps live elements and the images they show across save, load and clear", async () => {
    const shown = element({ id: "shown", type: "image", fileId: "f-shown" });
    const erased = element({ id: "erased", type: "image", fileId: "f-erased", isDeleted: true });
    const arrow = element({ id: "arrow", type: "arrow" });
    const files: BinaryFiles = { "f-shown": file("f-shown"), "f-erased": file("f-erased") };
    const appState = { scrollX: 12, scrollY: -4, zoom: { value: 1.5 } };

    await saveBoard(toBoardSnapshot([shown, erased, arrow], appState, files));
    const loaded = await loadBoard();

    expect(loaded?.elements.map(({ id }) => id)).toEqual(["shown", "arrow"]);
    expect(Object.keys(loaded?.files ?? {})).toEqual(["f-shown"]);
    expect(loaded?.viewport).toEqual({ scrollX: 12, scrollY: -4, zoom: 1.5 });

    await clearBoard();
    expect(await loadBoard()).toBeNull();
  });
});
