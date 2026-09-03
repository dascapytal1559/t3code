import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";

import {
  EnvironmentId,
  PreviewAnnotationPayloadSchema,
  ThreadId,
  type PreviewAnnotationPayload,
} from "@t3tools/contracts";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";

import {
  hydrateImagesFromPersisted,
  PersistedComposerDraftFileAttachment,
  PersistedComposerImageAttachment,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "./composerDraftStore";
import { ReviewCommentContextSchema, type ReviewCommentContext } from "./reviewCommentContext";
import { type ElementContextDraft } from "./lib/elementContext";
import { type TerminalContextDraft } from "./lib/terminalContext";
import { createDebouncedStorage, createMemoryStorage } from "./lib/storage";
import { randomUUID } from "./lib/utils";

export const QUEUED_FOLLOW_UP_STORAGE_KEY = "t3code:queued-follow-ups:v1";
export const MAX_QUEUED_FOLLOW_UPS = 10;

const PersistedTerminalContextDraft = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  createdAt: Schema.String,
  terminalId: Schema.String,
  terminalLabel: Schema.String,
  lineStart: Schema.Number,
  lineEnd: Schema.Number,
});

const PersistedElementContextStackFrame = Schema.Struct({
  functionName: Schema.NullOr(Schema.String),
  fileName: Schema.NullOr(Schema.String),
  lineNumber: Schema.NullOr(Schema.Number),
  columnNumber: Schema.NullOr(Schema.Number),
});

const PersistedElementContextDraft = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  pickedAt: Schema.String,
  pageUrl: Schema.String,
  pageTitle: Schema.NullOr(Schema.String),
  tagName: Schema.String,
  selector: Schema.NullOr(Schema.String),
  htmlPreview: Schema.String,
  componentName: Schema.NullOr(Schema.String),
  source: Schema.NullOr(PersistedElementContextStackFrame),
  styles: Schema.String,
});

const PersistedQueuedFollowUp = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  prompt: Schema.String,
  attachments: Schema.Array(PersistedComposerImageAttachment),
  files: Schema.optionalKey(Schema.Array(PersistedComposerDraftFileAttachment)),
  terminalContexts: Schema.optionalKey(Schema.Array(PersistedTerminalContextDraft)),
  elementContexts: Schema.optionalKey(Schema.Array(PersistedElementContextDraft)),
  previewAnnotations: Schema.optionalKey(Schema.Array(PreviewAnnotationPayloadSchema)),
  reviewComments: Schema.optionalKey(Schema.Array(ReviewCommentContextSchema)),
});
export type PersistedQueuedFollowUp = typeof PersistedQueuedFollowUp.Type;

const PersistedQueuedFollowUpStoreState = Schema.Struct({
  itemsByThreadKey: Schema.Record(Schema.String, Schema.Array(PersistedQueuedFollowUp)),
});
type PersistedQueuedFollowUpStoreState = typeof PersistedQueuedFollowUpStoreState.Type;

const decodePersistedQueuedFollowUpStoreState = Schema.decodeUnknownSync(
  PersistedQueuedFollowUpStoreState,
);

export interface QueuedFollowUp {
  id: string;
  createdAt: string;
  prompt: string;
  images: ComposerImageAttachment[];
  files: ComposerFileAttachment[];
  persistedAttachments: PersistedComposerImageAttachment[];
  terminalContexts: TerminalContextDraft[];
  elementContexts: ElementContextDraft[];
  previewAnnotations: PreviewAnnotationPayload[];
  reviewComments: ReviewCommentContext[];
}

export interface QueuedFollowUpDraft {
  prompt: string;
  images: ReadonlyArray<ComposerImageAttachment>;
  files: ReadonlyArray<ComposerFileAttachment>;
  persistedAttachments: ReadonlyArray<PersistedComposerImageAttachment>;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  elementContexts: ReadonlyArray<ElementContextDraft>;
  previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  reviewComments: ReadonlyArray<ReviewCommentContext>;
}

function persistFile(file: ComposerFileAttachment): PersistedComposerDraftFileAttachment {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    ...(file.uploadedAttachmentId && file.uploadEnvironmentId
      ? {
          attachmentId: file.uploadedAttachmentId,
          environmentId: file.uploadEnvironmentId,
        }
      : {}),
  };
}

function hydrateFile(file: PersistedComposerDraftFileAttachment): ComposerFileAttachment {
  return {
    type: "file",
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    file: null,
    ...(file.attachmentId !== undefined && file.environmentId !== undefined
      ? { uploadedAttachmentId: file.attachmentId, uploadEnvironmentId: file.environmentId }
      : {}),
  };
}

function toPersistedFollowUp(item: QueuedFollowUp): PersistedQueuedFollowUp {
  return {
    id: item.id,
    createdAt: item.createdAt,
    prompt: item.prompt,
    attachments: item.persistedAttachments,
    ...(item.files.length > 0 ? { files: item.files.map(persistFile) } : {}),
    ...(item.terminalContexts.length > 0
      ? {
          terminalContexts: item.terminalContexts.map((context) => ({
            id: context.id,
            threadId: context.threadId,
            createdAt: context.createdAt,
            terminalId: context.terminalId,
            terminalLabel: context.terminalLabel,
            lineStart: context.lineStart,
            lineEnd: context.lineEnd,
          })),
        }
      : {}),
    ...(item.elementContexts.length > 0 ? { elementContexts: [...item.elementContexts] } : {}),
    ...(item.previewAnnotations.length > 0
      ? { previewAnnotations: [...item.previewAnnotations] }
      : {}),
    ...(item.reviewComments.length > 0 ? { reviewComments: [...item.reviewComments] } : {}),
  };
}

function toHydratedFollowUp(item: PersistedQueuedFollowUp): QueuedFollowUp {
  return {
    id: item.id,
    createdAt: item.createdAt,
    prompt: item.prompt,
    images: hydrateImagesFromPersisted(item.attachments),
    files: (item.files ?? []).map(hydrateFile),
    persistedAttachments: [...item.attachments],
    terminalContexts: (item.terminalContexts ?? []).map((context) => ({
      ...context,
      text: "",
    })),
    elementContexts: [...(item.elementContexts ?? [])],
    previewAnnotations: [...(item.previewAnnotations ?? [])],
    reviewComments: [...(item.reviewComments ?? [])],
  };
}

export function queuedFollowUpPreview(
  item: Pick<QueuedFollowUp, "prompt" | "images" | "files">,
): string {
  const text = item.prompt.trim();
  if (text.length > 0) return text;
  const named = item.images[0]?.name ?? item.files[0]?.name;
  return named ?? "Queued message";
}

export function queuedFollowUpHasAttachments(
  item: Pick<QueuedFollowUp, "images" | "files" | "terminalContexts" | "elementContexts">,
): boolean {
  return (
    item.images.length > 0 ||
    item.files.length > 0 ||
    item.terminalContexts.length > 0 ||
    item.elementContexts.length > 0
  );
}

function newFollowUpId(): string {
  return randomUUID();
}

interface QueuedFollowUpStoreState {
  itemsByThreadKey: Record<string, QueuedFollowUp[]>;
  enqueue: (
    threadKey: string,
    draft: QueuedFollowUpDraft,
  ) => { item: QueuedFollowUp } | { error: "empty" | "full" };
  remove: (threadKey: string, followUpId: string) => void;
  clearEnvironment: (environmentId: EnvironmentId) => void;
}

const queuedFollowUpStorage = createDebouncedStorage(
  typeof localStorage !== "undefined" ? localStorage : createMemoryStorage(),
  300,
);

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    queuedFollowUpStorage.flush();
  });
}

export const useQueuedFollowUpStore = create<QueuedFollowUpStoreState>()(
  persist(
    (set, get) => ({
      itemsByThreadKey: {},
      enqueue: (threadKey, draft) => {
        const hasContent =
          draft.prompt.trim().length > 0 ||
          draft.images.length > 0 ||
          draft.files.length > 0 ||
          draft.terminalContexts.length > 0 ||
          draft.elementContexts.length > 0 ||
          draft.previewAnnotations.length > 0 ||
          draft.reviewComments.length > 0;
        if (!hasContent) {
          return { error: "empty" };
        }
        const existing = get().itemsByThreadKey[threadKey] ?? [];
        if (existing.length >= MAX_QUEUED_FOLLOW_UPS) {
          return { error: "full" };
        }
        const item: QueuedFollowUp = {
          id: newFollowUpId(),
          createdAt: new Date().toISOString(),
          prompt: draft.prompt,
          images: [...draft.images],
          files: [...draft.files],
          persistedAttachments: [...draft.persistedAttachments],
          terminalContexts: [...draft.terminalContexts],
          elementContexts: [...draft.elementContexts],
          previewAnnotations: [...draft.previewAnnotations],
          reviewComments: [...draft.reviewComments],
        };
        set({
          itemsByThreadKey: {
            ...get().itemsByThreadKey,
            [threadKey]: [...existing, item],
          },
        });
        return { item };
      },
      remove: (threadKey, followUpId) => {
        const existing = get().itemsByThreadKey[threadKey];
        if (!existing) return;
        const next = existing.filter((item) => item.id !== followUpId);
        const itemsByThreadKey = { ...get().itemsByThreadKey };
        if (next.length === 0) {
          delete itemsByThreadKey[threadKey];
        } else {
          itemsByThreadKey[threadKey] = next;
        }
        set({ itemsByThreadKey });
      },
      clearEnvironment: (environmentId) => {
        const itemsByThreadKey = Object.fromEntries(
          Object.entries(get().itemsByThreadKey).filter(([threadKey]) => {
            return parseScopedThreadKey(threadKey)?.environmentId !== environmentId;
          }),
        );
        set({ itemsByThreadKey });
      },
    }),
    {
      name: QUEUED_FOLLOW_UP_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => queuedFollowUpStorage),
      partialize: (state) => ({
        itemsByThreadKey: Object.fromEntries(
          Object.entries(state.itemsByThreadKey).flatMap(([threadKey, items]) =>
            items.length > 0 ? [[threadKey, items.map(toPersistedFollowUp)]] : [],
          ),
        ),
      }),
      merge: (persistedState, currentState) => {
        const persistedRecord =
          persistedState && typeof persistedState === "object"
            ? ((persistedState as { state?: unknown }).state ?? persistedState)
            : persistedState;
        let decoded: PersistedQueuedFollowUpStoreState;
        try {
          decoded = decodePersistedQueuedFollowUpStoreState(persistedRecord);
        } catch {
          return currentState;
        }
        return {
          ...currentState,
          itemsByThreadKey: Object.fromEntries(
            Object.entries(decoded.itemsByThreadKey).map(([threadKey, items]) => [
              threadKey,
              items.map(toHydratedFollowUp),
            ]),
          ),
        };
      },
    },
  ),
);

export function useQueuedFollowUps(threadKey: string | null): ReadonlyArray<QueuedFollowUp> {
  return useQueuedFollowUpStore(
    useShallow((state) => (threadKey ? (state.itemsByThreadKey[threadKey] ?? []) : [])),
  );
}

export function enqueueQueuedFollowUp(
  threadKey: string,
  draft: QueuedFollowUpDraft,
): { item: QueuedFollowUp } | { error: "empty" | "full" } {
  return useQueuedFollowUpStore.getState().enqueue(threadKey, draft);
}

export function removeQueuedFollowUp(threadKey: string, followUpId: string): void {
  useQueuedFollowUpStore.getState().remove(threadKey, followUpId);
}

export function clearQueuedFollowUpsForEnvironment(environmentId: EnvironmentId): void {
  useQueuedFollowUpStore.getState().clearEnvironment(environmentId);
}
