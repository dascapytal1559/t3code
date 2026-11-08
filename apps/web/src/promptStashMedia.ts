import type { ComposerFileAttachment, ComposerImageAttachment } from "./composerDraftStore";
import type { StashedMedia } from "./promptStashStore";

// localStorage holds each entry's text and media metadata; the bytes live here, keyed by entry id,
// so no size budget drops or shrinks a stashed image or file.
const DATABASE_NAME = "t3code:prompt-stash-media";
const DATABASE_VERSION = 1;
const STORE_NAME = "media";

type StoredMedia = Readonly<Record<string, Blob>>;

let database: Promise<IDBDatabase> | undefined;

function openDatabase() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => {
      database = undefined;
      reject(request.error);
    });
  }));
}

async function withStore<A>(
  mode: IDBTransactionMode,
  use: (store: IDBObjectStore) => IDBRequest<A> | void,
) {
  const transaction = (await openDatabase()).transaction(STORE_NAME, mode);
  const request = use(transaction.objectStore(STORE_NAME));
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
  return request?.result;
}

/** Resolves once the bytes are committed; rejects when the browser refuses them (quota, no IndexedDB). */
export async function writeStashMedia(
  entryId: string,
  blobs: ReadonlyMap<string, Blob>,
): Promise<void> {
  if (blobs.size === 0) return;
  const value: StoredMedia = Object.fromEntries(blobs);
  await withStore("readwrite", (store) => store.put(value, entryId));
}

/**
 * Rejects when storage cannot be read; an entry with no stored bytes reads as empty.
 * `inMemory` copies each blob out of IndexedDB, so deleting the stored copy cannot strand it.
 */
export async function readStashMedia(
  entryId: string,
  options?: { readonly inMemory?: boolean },
): Promise<ReadonlyMap<string, Blob>> {
  const stored = await withStore<StoredMedia | undefined>("readonly", (store) =>
    store.get(entryId),
  );
  const entries = Object.entries(stored ?? {});
  if (!options?.inMemory) return new Map(entries);
  return new Map(
    await Promise.all(
      entries.map(
        async ([id, blob]) =>
          [id, new Blob([await blob.arrayBuffer()], { type: blob.type })] as const,
      ),
    ),
  );
}

export function deleteStashMedia(entryId: string): void {
  void withStore("readwrite", (store) => store.delete(entryId)).catch((error: unknown) => {
    console.error("[PROMPT-STASH] Could not delete stashed media.", error);
  });
}

/** Turns stashed media back into composer attachments; files then upload like freshly attached ones. */
export function hydrateStashMedia(
  media: ReadonlyArray<StashedMedia>,
  blobs: ReadonlyMap<string, Blob>,
): {
  images: ComposerImageAttachment[];
  files: ComposerFileAttachment[];
  missingNames: string[];
} {
  const images: ComposerImageAttachment[] = [];
  const files: ComposerFileAttachment[] = [];
  const missingNames: string[] = [];
  for (const item of media) {
    const blob = blobs.get(item.id);
    if (!blob) {
      missingNames.push(item.name);
      continue;
    }
    const file = new File([blob], item.name, { type: item.mimeType });
    if (item.type === "image") {
      images.push({
        type: "image",
        id: item.id,
        name: item.name,
        mimeType: item.mimeType,
        sizeBytes: file.size,
        previewUrl: URL.createObjectURL(file),
        file,
        ...(item.source ? { source: item.source } : {}),
      });
    } else {
      files.push({
        type: "file",
        id: item.id,
        name: item.name,
        mimeType: item.mimeType,
        sizeBytes: file.size,
        file,
        ...(item.source ? { source: item.source } : {}),
      });
    }
  }
  return { images, files, missingNames };
}
