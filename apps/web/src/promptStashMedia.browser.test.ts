import { expect, it, vi } from "vite-plus/test";

import { deleteOrphanStashMedia, readStashMedia, writeStashMedia } from "./promptStashMedia";

const blob = (text: string) => new Blob([text], { type: "text/plain" });

// What versions before `writtenAt` stored: the blob map itself.
async function writeLegacyRecord(entryId: string, blobs: Record<string, Blob>) {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("t3code:prompt-stash-media", 1);
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
  const transaction = database.transaction("media", "readwrite");
  transaction.objectStore("media").put(blobs, entryId);
  await new Promise((resolve) => transaction.addEventListener("complete", resolve));
  database.close();
}

it("clears bytes no entry uses, but not bytes another tab may be about to list", async () => {
  const writtenAt = 1_000_000;
  using _now = vi.spyOn(Date, "now").mockReturnValue(writtenAt);
  await writeStashMedia("live", new Map([["a", blob("live")]]));
  await writeStashMedia("orphan", new Map([["b", blob("orphan")]]));
  await writeLegacyRecord("legacy-live", { c: blob("legacy") });
  await writeLegacyRecord("legacy-orphan", { d: blob("gone") });
  const live = new Set(["live", "legacy-live"]);
  const contents = async (entryId: string) =>
    Promise.all([...(await readStashMedia(entryId)).values()].map((stored) => stored.text()));

  await deleteOrphanStashMedia(live, writtenAt);
  expect(await contents("orphan")).toEqual(["orphan"]);
  expect(await contents("legacy-orphan")).toEqual([]);

  await deleteOrphanStashMedia(live, writtenAt + 1);
  expect(await contents("orphan")).toEqual([]);
  expect(await contents("live")).toEqual(["live"]);
  expect(await contents("legacy-live")).toEqual(["legacy"]);
});
