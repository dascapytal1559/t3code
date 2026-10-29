import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES, type ScopedThreadRef } from "@t3tools/contracts";

import {
  type DraftId,
  type PersistedComposerImageAttachment,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { compressImageToByteLimit, readFileAsDataUrl } from "../../lib/imageCompression";
import { randomUUID } from "../../lib/utils";

export type BoardAttachTarget = DraftId | ScopedThreadRef;

export async function attachBoardImage(target: BoardAttachTarget, png: Blob): Promise<void> {
  const compressed = await compressImageToByteLimit(
    new File([png], `board-${new Date().toISOString().replace(/[:.]/g, "-")}.png`, {
      type: "image/png",
    }),
    PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  );
  if (!compressed.ok) throw new Error("The board is too large to attach.");
  const { file } = compressed;
  const dataUrl = await readFileAsDataUrl(file);
  const id = randomUUID();
  const store = useComposerDraftStore.getState();
  const added = store.addImage(target, {
    type: "image",
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: dataUrl,
    file,
  });
  if (!added) throw new Error("Remove an attachment from that chat, then try again.");
  const persisted: PersistedComposerImageAttachment = {
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    dataUrl,
  };
  const existing = store.getComposerDraft(target)?.persistedAttachments ?? [];
  await store.syncPersistedAttachments(target, [...existing, persisted]);
}
