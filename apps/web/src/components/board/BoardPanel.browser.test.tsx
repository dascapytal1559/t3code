import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { DraftId } from "../../composerDraftStore";
import { isEditableFocused } from "../../lib/editableFocus";
import { pasteTextToFocusComposer, shouldTypeToFocusComposer } from "../chat/composerFocusRedirect";
import { BoardPanel } from "./BoardPanel";

function paste(target: HTMLElement, data: File | string) {
  const clipboardData = new DataTransfer();
  if (typeof data === "string") clipboardData.setData("text/plain", data);
  else clipboardData.items.add(data);
  const event = new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

async function screenshot() {
  const canvas = new OffscreenCanvas(40, 20);
  canvas.getContext("2d")?.fillRect(0, 0, 40, 20);
  return new File([await canvas.convertToBlob({ type: "image/png" })], "shot.png", {
    type: "image/png",
  });
}

describe("BoardPanel", () => {
  it("keeps canvas keys and pastes apart from the chat beside it", async () => {
    await using screen = await render(
      <div style={{ display: "flex", width: 900, height: 600 }}>
        <textarea aria-label="Composer" />
        <div
          data-workspace-area="panel"
          style={{ display: "flex", flexDirection: "column", width: 420 }}
        >
          <BoardPanel composerDraftTarget={DraftId.make("board-test-draft")} />
        </div>
      </div>,
    );
    await expect.element(screen.getByRole("button", { name: "Copy board" })).toBeEnabled();
    const canvas = screen.container.querySelector<HTMLElement>(".excalidraw-container");
    const composer = screen.container.querySelector("textarea");
    if (!canvas || !composer) throw new Error("Board or composer missing.");

    canvas.focus();
    expect(isEditableFocused()).toBe(true);
    const toolKey = new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true });
    canvas.dispatchEvent(toolKey);
    expect(shouldTypeToFocusComposer(toolKey)).toBe(false);
    expect(pasteTextToFocusComposer(paste(canvas, "label"))).toBeNull();
    expect(paste(canvas, await screenshot()).defaultPrevented).toBe(true);

    composer.focus();
    expect(paste(composer, await screenshot()).defaultPrevented).toBe(false);
  });
});
