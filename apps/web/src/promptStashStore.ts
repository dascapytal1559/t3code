import {
  ComposerContextRecord,
  ForwardCompatibleArray,
  PastedTextAttachmentSource,
  SnapShotSource,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import {
  PersistedComposerFileAttachment,
  PersistedComposerImageAttachment,
} from "./composerDraftStore";
import { createMemoryStorage, type StateStorage } from "./lib/storage";

export const PROMPT_STASH_STORAGE_KEY = "t3code:prompt-stash:v2";
const LEGACY_PROMPT_STASH_STORAGE_KEY = "t3code:prompt-stash:v1";
const PROMPT_STASH_STORAGE_VERSION = 2;

export const MAX_STASH_ENTRIES = 20;

const StashedImage = Schema.Struct({
  type: Schema.Literal("image"),
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  source: Schema.optional(SnapShotSource),
});

const StashedFile = Schema.Struct({
  type: Schema.Literal("file"),
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  source: Schema.optional(PastedTextAttachmentSource),
});

/** Metadata only; the bytes are in IndexedDB (promptStashMedia.ts) under the entry id. */
export const StashedMedia = Schema.Union([StashedImage, StashedFile]);
export type StashedMedia = typeof StashedMedia.Type;

const StashEntrySchema = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  prompt: Schema.String,
  media: Schema.optionalKey(Schema.Array(StashedMedia)),
  /** Composer files stashed as references to their pending server upload. */
  files: Schema.optionalKey(Schema.Array(PersistedComposerFileAttachment)),
  /** Entries saved before media moved to IndexedDB inline their images and may have dropped some. */
  attachments: Schema.optionalKey(Schema.Array(PersistedComposerImageAttachment)),
  droppedImageNames: Schema.optionalKey(Schema.Array(Schema.String)),
  unreadableImageNames: Schema.optionalKey(Schema.Array(Schema.String)),
  records: Schema.optionalKey(ForwardCompatibleArray(ComposerContextRecord)),
});
export type PromptStashEntry = typeof StashEntrySchema.Type;

const PersistedPromptStashState = Schema.Struct({
  entries: Schema.Array(StashEntrySchema),
});

const decodePersistedPromptStashState = Schema.decodeUnknownSync(PersistedPromptStashState);

// Accessing localStorage itself can throw SecurityError before get/set.
function resolveBaseStorage(): { storage: StateStorage; durable: boolean } {
  try {
    if (typeof localStorage !== "undefined") {
      return { storage: localStorage, durable: true };
    }
  } catch {}
  return { storage: createMemoryStorage(), durable: false };
}

const { storage: baseStashStorage, durable: storageIsDurable } = resolveBaseStorage();

// Clear the composer only after a durable write; debounce cannot confirm durability.
function persistEntries(entries: ReadonlyArray<PromptStashEntry>): {
  written: boolean;
  durable: boolean;
} {
  try {
    baseStashStorage.setItem(
      PROMPT_STASH_STORAGE_KEY,
      JSON.stringify({
        version: PROMPT_STASH_STORAGE_VERSION,
        state: { entries },
      }),
    );
    return { written: true, durable: storageIsDurable };
  } catch (error) {
    console.error("[PROMPT-STASH] Could not persist stash (storage quota?).", error);
    return { written: false, durable: false };
  }
}

function readPersistedEntries(): ReadonlyArray<PromptStashEntry> | null {
  try {
    const raw = baseStashStorage.getItem(PROMPT_STASH_STORAGE_KEY);
    if (typeof raw !== "string" || raw.length === 0) return null;
    const parsed: unknown = JSON.parse(raw);
    const state = (parsed as { state?: unknown } | null)?.state;
    if (!state) return null;
    return decodePersistedPromptStashState(state).entries;
  } catch {
    return null;
  }
}

interface PromptStashStoreState {
  entries: ReadonlyArray<PromptStashEntry>;
  stashEntry: (entry: PromptStashEntry) => {
    evicted: PromptStashEntry | null;
    /** False when the write failed outright (e.g. quota); nothing was kept. */
    written: boolean;
    /** False for failed writes or in-memory fallback; the entry will not survive reload. */
    durable: boolean;
  };
  /** durable=false means removal was not persisted and reload would restore the entry. */
  takeEntry: (entryId: string) => { entry: PromptStashEntry | null; durable: boolean };
  /** Reverses a `stashEntry` whose surrounding step failed, putting back what it evicted. */
  undoStash: (entryId: string, evicted: PromptStashEntry | null) => { durable: boolean };
  /** The stash badge replays its one-shot pulse each time this changes. */
  pulseKey: number;
  pulse: () => void;
}

export const usePromptStashStore = create<PromptStashStoreState>()((set, get) => ({
  entries: [],
  pulseKey: 0,
  pulse: () => set((state) => ({ pulseKey: state.pulseKey + 1 })),
  undoStash: (entryId, evicted) => {
    const nextEntries = [
      ...get().entries.filter((candidate) => candidate.id !== entryId),
      ...(evicted ? [evicted] : []),
    ];
    const { durable } = persistEntries(nextEntries);
    set(() => ({ entries: nextEntries }));
    return { durable };
  },
  stashEntry: (entry) => {
    const nextEntries = [entry, ...get().entries];
    const evicted = nextEntries.length > MAX_STASH_ENTRIES ? (nextEntries.pop() ?? null) : null;
    const { written, durable } = persistEntries(nextEntries);
    // Failed writes must not duplicate the intact composer; eviction also commits only on success.
    if (!written) {
      return { evicted: null, written: false, durable: false };
    }
    set(() => ({ entries: nextEntries }));
    return { evicted, written: true, durable };
  },
  takeEntry: (entryId) => {
    const entries = get().entries;
    const entry = entries.find((candidate) => candidate.id === entryId) ?? null;
    if (!entry) return { entry: null, durable: true };
    const nextEntries = entries.filter((candidate) => candidate.id !== entryId);
    const { durable } = persistEntries(nextEntries);
    set(() => ({ entries: nextEntries }));
    return { entry, durable };
  },
}));

{
  try {
    baseStashStorage.removeItem(LEGACY_PROMPT_STASH_STORAGE_KEY);
  } catch {}
  const persisted = readPersistedEntries();
  if (persisted) {
    usePromptStashStore.setState({ entries: persisted });
  }
}

export function writePromptStashStorageForTest(raw: string): void {
  baseStashStorage.setItem(PROMPT_STASH_STORAGE_KEY, raw);
  usePromptStashStore.setState({ entries: readPersistedEntries() ?? [] });
}
