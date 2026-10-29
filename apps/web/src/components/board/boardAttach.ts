import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES, ScopedThreadRef } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import {
  DraftId,
  type PersistedComposerImageAttachment,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { compressImageToByteLimit, readFileAsDataUrl } from "../../lib/imageCompression";
import { randomUUID } from "../../lib/utils";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { resolveExistingSnapShotTarget } from "../desktop/SnapShotCoordinator";

export type BoardAttachTarget = DraftId | ScopedThreadRef;

const LAST_TARGET_STORAGE_KEY = "t3code:board:attach-target:v1";
const BoardAttachTargetSchema = Schema.Union([ScopedThreadRef, DraftId]);

/**
 * Remembers the last thread or draft on screen, which is where "Attach to chat" sends the board.
 * Stored so a reload or restart on the board still knows it.
 */
export function startBoardAttachTargetTracking(router: AnyRouter): () => void {
  const record = () => {
    const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
    if (!target) return;
    try {
      setLocalStorageItem(
        LAST_TARGET_STORAGE_KEY,
        target.kind === "server" ? target.threadRef : target.draftId,
        BoardAttachTargetSchema,
      );
    } catch {}
  };
  record();
  return router.subscribe("onResolved", record);
}

/** The remembered target, following a draft that has since become a server thread. */
export function readBoardAttachTarget(): BoardAttachTarget | null {
  try {
    const target = getLocalStorageItem(LAST_TARGET_STORAGE_KEY, BoardAttachTargetSchema);
    return target ? resolveExistingSnapShotTarget(target, null) : null;
  } catch {
    return null;
  }
}

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
