import type { ChatAttachment, OrchestrationMessageContext } from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { expect, it, vi } from "vite-plus/test";

import { composerFileNeedsReattach } from "../../composerDraftStore";
import { hydrateStashMedia, readStashMedia } from "../../promptStashMedia";
import { usePromptStashStore } from "../../promptStashStore";
import { stashQueuedMessage } from "./promptStashActions";

// The localStorage budget that used to drop stashed images whole.
const OLD_ENTRY_CAP_CHARS = 2_700_000;

function setup() {
  usePromptStashStore.setState({ entries: [] });
}

function bytes(size: number, fill: number) {
  return new Uint8Array(size).fill(fill);
}

const attachments = [
  { type: "image", id: "t1-a-png", name: "small.png", mimeType: "image/png", sizeBytes: 64 },
  { type: "image", id: "t1-b-png", name: "huge.png", mimeType: "image/png", sizeBytes: 3_000_000 },
  { type: "image", id: "t1-c-webp", name: "third.webp", mimeType: "image/webp", sizeBytes: 96 },
  { type: "file", id: "t1-d-md", name: "notes.md", mimeType: "text/markdown", sizeBytes: 5 },
] as unknown as ReadonlyArray<ChatAttachment>;

const contents = new Map<string, Uint8Array<ArrayBuffer>>([
  ["t1-a-png", bytes(64, 1)],
  ["t1-b-png", bytes(3_000_000, 2)],
  ["t1-c-webp", bytes(96, 3)],
  ["t1-d-md", new TextEncoder().encode("# hi\n")],
]);

const record = (kind: "image" | "file", composerId: string, attachment: ChatAttachment) => ({
  version: 1,
  kind,
  contextId: `${kind}_${composerId}`,
  label: attachment.name,
  attachmentId: attachment.id,
  name: attachment.name,
  mimeType: attachment.mimeType,
  sizeBytes: attachment.sizeBytes,
});

const terminalRecord = {
  version: 1,
  kind: "terminal",
  contextId: "terminal_t-1",
  label: "Terminal 1 line 2",
  terminalId: "default",
  terminalLabel: "Terminal 1",
  lineStart: 2,
  lineEnd: 2,
  text: "boom",
};

const context = {
  version: 1,
  records: [
    record("image", "img-a", attachments[0]!),
    record("image", "img-b", attachments[1]!),
    record("image", "img-c", attachments[2]!),
    record("file", "doc-d", attachments[3]!),
    terminalRecord,
  ],
} as unknown as OrchestrationMessageContext;

const text = `Compare these ${formatComposerContextReference({
  kind: "image",
  contextId: "image_img-b" as never,
  label: "huge.png",
})} with ${formatComposerContextReference({
  kind: "file",
  contextId: "file_doc-d" as never,
  label: "notes.md",
})}`;

const download = async (attachment: ChatAttachment) => {
  const data = contents.get(attachment.id);
  return data ? new Blob([data], { type: attachment.mimeType }) : null;
};

it("stashes a queued message with every attachment and restores them sendable", async () => {
  setup();
  expect(contents.get("t1-b-png")!.length * (4 / 3)).toBeGreaterThan(OLD_ENTRY_CAP_CHARS);
  const removeFromQueue = vi.fn(async () => true);

  const outcome = await stashQueuedMessage({
    text,
    attachments,
    context,
    download,
    removeFromQueue,
  });

  expect(outcome.ok).toBe(true);
  expect(removeFromQueue).toHaveBeenCalledOnce();
  const [entry] = usePromptStashStore.getState().entries;
  expect(entry?.prompt).toBe(text);
  // The text's inline references keep pointing at the attachments they named.
  expect(entry?.media?.map((item) => [item.type, item.id, item.name])).toEqual([
    ["image", "img-a", "small.png"],
    ["image", "img-b", "huge.png"],
    ["image", "img-c", "third.webp"],
    ["file", "doc-d", "notes.md"],
  ]);
  expect(entry?.records).toEqual([terminalRecord]);

  const restored = hydrateStashMedia(
    entry!.media!,
    await readStashMedia(entry!.id, { inMemory: true }),
  );
  expect(restored.missingNames).toEqual([]);
  expect(restored.images.map((image) => image.name)).toEqual([
    "small.png",
    "huge.png",
    "third.webp",
  ]);
  for (const [index, image] of restored.images.entries()) {
    const original = contents.get(attachments[index]!.id)!;
    expect(image.file.type).toBe(attachments[index]!.mimeType);
    expect(new Uint8Array(await image.file.arrayBuffer())).toEqual(original);
  }
  const [file] = restored.files;
  expect(file && composerFileNeedsReattach(file)).toBe(false);
  expect(await file?.file?.text()).toBe("# hi\n");
});

it("leaves the queue and the stash untouched when a stash step fails", async () => {
  setup();
  const removeFromQueue = vi.fn(async () => true);
  const failedDownload = await stashQueuedMessage({
    text,
    attachments,
    context,
    download: async (attachment) =>
      attachment.id === "t1-c-webp" ? null : await download(attachment),
    removeFromQueue,
  });
  expect(failedDownload).toEqual({
    ok: false,
    reason: "Couldn't download third.webp. The message is still queued.",
  });
  expect(removeFromQueue).not.toHaveBeenCalled();
  expect(usePromptStashStore.getState().entries).toEqual([]);

  const refused = await stashQueuedMessage({
    text,
    attachments,
    context,
    download,
    removeFromQueue: async () => false,
  });
  expect(refused.ok).toBe(false);
  expect(usePromptStashStore.getState().entries).toEqual([]);
});
