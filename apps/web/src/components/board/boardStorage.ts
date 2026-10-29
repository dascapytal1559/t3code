import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

const DATABASE_NAME = "t3code:board";
const DATABASE_VERSION = 1;
const STORE_NAME = "boards";
const BOARD_KEY = "default";

interface BoardViewport {
  readonly scrollX: number;
  readonly scrollY: number;
  readonly zoom: { readonly value: number };
}

export interface BoardSnapshot {
  readonly elements: ReadonlyArray<ExcalidrawElement>;
  readonly files: BinaryFiles;
  readonly viewport: { readonly scrollX: number; readonly scrollY: number; readonly zoom: number };
}

/** Keeps live elements and only the images they still show, so erased screenshots free their space. */
export function toBoardSnapshot(
  elements: ReadonlyArray<ExcalidrawElement>,
  appState: BoardViewport,
  files: BinaryFiles,
): BoardSnapshot {
  const live = elements.filter((element) => !element.isDeleted);
  const keptFiles: BinaryFiles = {};
  for (const element of live) {
    if (element.type !== "image" || element.fileId === null) continue;
    const file = files[element.fileId];
    if (file) keptFiles[element.fileId] = file;
  }
  return {
    elements: live,
    files: keptFiles,
    viewport: { scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom.value },
  };
}

/**
 * Debounces saves of the scenes Excalidraw reports. Flushing never reads the editor, which is
 * already torn down when the page unmounts. The first report is the loaded board, so it is skipped.
 */
export function createBoardSaver(save: (snapshot: BoardSnapshot) => void, delayMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastKey: string | null = null;
  let pending: (() => BoardSnapshot) | null = null;
  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const next = pending;
    pending = null;
    if (next) save(next());
  };
  const change = (
    elements: ReadonlyArray<ExcalidrawElement>,
    appState: BoardViewport,
    files: BinaryFiles,
  ) => {
    // Every edit, delete or reorder bumps an element's version.
    let versions = 0;
    for (const element of elements) versions += element.version;
    const key = `${elements.length}:${versions}:${appState.scrollX}:${appState.scrollY}:${appState.zoom.value}:${Object.keys(files).length}`;
    if (lastKey === null || key === lastKey) {
      lastKey = key;
      return;
    }
    lastKey = key;
    pending = () => toBoardSnapshot(elements, appState, files);
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, delayMs);
  };
  return { change, flush };
}

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

export async function loadBoard(): Promise<BoardSnapshot | null> {
  const stored = await withStore<BoardSnapshot | undefined>("readonly", (store) =>
    store.get(BOARD_KEY),
  );
  return stored ?? null;
}

export async function saveBoard(snapshot: BoardSnapshot): Promise<void> {
  await withStore("readwrite", (store) => store.put(snapshot, BOARD_KEY));
}

export async function clearBoard(): Promise<void> {
  await withStore("readwrite", (store) => store.delete(BOARD_KEY));
}
