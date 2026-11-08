import {
  ChatFileAttachment,
  ChatImageAttachment,
  type ChatAttachment,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";
import { stripAttachmentOnlyBootstrapPrompt } from "@t3tools/shared/composerContextReferences";
import * as Schema from "effect/Schema";

import { releasePersistedAttachmentUpload } from "../../lib/attachmentUploadQueue";
import { deleteStashMedia, writeStashMedia } from "../../promptStashMedia";
import {
  MAX_STASH_ENTRIES,
  type PromptStashEntry,
  type StashedMedia,
  usePromptStashStore,
} from "../../promptStashStore";
import { asKnownContextRecord } from "~/lib/composerContextRecords";
import { producerIdFromComposerContextId } from "~/lib/composerContextReferences";
import { randomUUID } from "~/lib/utils";
import { toastManager } from "../ui/toast";

const isImageAttachment = Schema.is(ChatImageAttachment);
const isFileAttachment = Schema.is(ChatFileAttachment);

/** Frees what an entry holds outside localStorage, once nothing can bring the entry back. */
export function discardStashEntryAttachments(entry: PromptStashEntry): void {
  for (const file of entry.files ?? []) {
    releasePersistedAttachmentUpload({
      id: file.id,
      environmentId: file.environmentId,
      attachmentId: file.attachmentId,
    });
  }
  if ((entry.media?.length ?? 0) > 0) deleteStashMedia(entry.id);
}

export function settleStashEviction(evicted: PromptStashEntry | null): void {
  if (!evicted) return;
  discardStashEntryAttachments(evicted);
  toastManager.add({
    type: "warning",
    title: "Oldest stashed prompt discarded",
    description: `The stash holds ${MAX_STASH_ENTRIES} prompts; the oldest was removed to make room.`,
    data: { hideCopyButton: true },
  });
}

export type QueuedMessageStashOutcome =
  | { readonly ok: true; readonly durable: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * Moves a queued message into the prompt stash in one step: its attachments are downloaded and
 * stored first, and the stash entry is undone when the queue refuses to let the message go.
 */
export async function stashQueuedMessage(input: {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context: OrchestrationMessageContext | undefined;
  readonly download: (attachment: ChatAttachment) => Promise<Blob | null>;
  readonly removeFromQueue: () => Promise<boolean>;
}): Promise<QueuedMessageStashOutcome> {
  const stillQueued = " The message is still queued.";
  const unsupported = input.attachments.filter(
    (attachment) => !isImageAttachment(attachment) && !isFileAttachment(attachment),
  );
  if (unsupported.length > 0) {
    return {
      ok: false,
      reason: `The stash cannot hold ${unsupported.map((attachment) => attachment.name).join(", ")}.${stillQueued}`,
    };
  }

  const blobs = await Promise.all(input.attachments.map(input.download));
  const failed = input.attachments.filter((_, index) => !blobs[index]);
  if (failed.length > 0) {
    return {
      ok: false,
      reason: `Couldn't download ${failed.map((attachment) => attachment.name).join(", ")}.${stillQueued}`,
    };
  }

  // Reusing each attachment's composer id keeps the text's inline references pointing at it.
  const records = input.context?.records ?? [];
  const composerIdByAttachmentId = new Map<string, string>();
  for (const candidate of records) {
    const record = asKnownContextRecord(candidate);
    if (record?.kind === "image" || record?.kind === "file") {
      composerIdByAttachmentId.set(
        record.attachmentId,
        producerIdFromComposerContextId(record.kind, record.contextId),
      );
    }
  }
  const media: StashedMedia[] = [];
  const bytes = new Map<string, Blob>();
  input.attachments.forEach((attachment, index) => {
    const blob = blobs[index];
    if (!blob) return;
    const preferredId = composerIdByAttachmentId.get(attachment.id);
    const id = preferredId === undefined || bytes.has(preferredId) ? randomUUID() : preferredId;
    bytes.set(id, blob);
    const base = { id, name: attachment.name, mimeType: attachment.mimeType, sizeBytes: blob.size };
    if (isImageAttachment(attachment)) {
      media.push({
        type: "image",
        ...base,
        ...(attachment.source ? { source: attachment.source } : {}),
      });
    } else if (isFileAttachment(attachment)) {
      media.push({
        type: "file",
        ...base,
        ...(attachment.source ? { source: attachment.source } : {}),
      });
    }
  });
  // Image and file bytes travel as media; the composer rebuilds their records on send.
  const keptRecords = records.filter((record) => record.kind !== "image" && record.kind !== "file");

  const entryId = randomUUID();
  try {
    await writeStashMedia(entryId, bytes);
  } catch (error) {
    console.error("[PROMPT-STASH] Could not store queued message attachments.", error);
    return {
      ok: false,
      reason: `Browser storage rejected its attachments. Free up site data and try again.${stillQueued}`,
    };
  }

  const store = usePromptStashStore.getState();
  const { evicted, written, durable } = store.stashEntry({
    id: entryId,
    createdAt: new Date().toISOString(),
    prompt: stripAttachmentOnlyBootstrapPrompt(input.text),
    ...(media.length > 0 ? { media } : {}),
    ...(keptRecords.length > 0 ? { records: keptRecords } : {}),
  });
  if (!written) {
    deleteStashMedia(entryId);
    return {
      ok: false,
      reason: `Browser storage rejected the write. Free up site data and try again.${stillQueued}`,
    };
  }

  if (!(await input.removeFromQueue())) {
    if (usePromptStashStore.getState().undoStash(entryId, evicted).durable) {
      deleteStashMedia(entryId);
    }
    return {
      ok: false,
      reason: "It could not be taken out of the queue, so it was not stashed. It may have started.",
    };
  }
  settleStashEviction(evicted);
  usePromptStashStore.getState().pulse();
  return { ok: true, durable };
}
