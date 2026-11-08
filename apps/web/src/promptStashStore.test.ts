import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  collectAssistantCitations,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";

import { removeLocalStorageItem } from "./hooks/useLocalStorage";

import {
  MAX_STASH_ENTRIES,
  PROMPT_STASH_STORAGE_KEY,
  usePromptStashStore,
  writePromptStashStorageForTest,
  type PromptStashEntry,
} from "./promptStashStore";

function makeEntry(input: { id: string; prompt?: string }): PromptStashEntry {
  return {
    id: input.id,
    createdAt: "2026-07-24T12:00:00.000Z",
    prompt: input.prompt ?? `prompt ${input.id}`,
  };
}

function resetPromptStashStore() {
  usePromptStashStore.setState({ entries: [] });
  writePromptStashStorageForTest("");
  removeLocalStorageItem(PROMPT_STASH_STORAGE_KEY);
}

describe("promptStashStore", () => {
  beforeEach(() => {
    resetPromptStashStore();
  });

  afterEach(() => {
    resetPromptStashStore();
  });

  it("restores citations and bound comments from a persisted stash", () => {
    const citation = {
      version: 1 as const,
      environmentId: EnvironmentId.make("remote-source"),
      threadId: ThreadId.make("source-thread"),
      messageId: MessageId.make("source-message"),
      text: "A quote to revisit later.",
      comment: "Revisit this tomorrow.\nCheck whether the example still applies.",
      start: 0,
      end: 24,
      prefix: "",
      suffix: " Next.",
    };
    const prompt = `Revisit ${serializeAssistantCitation(citation)}`;
    writePromptStashStorageForTest(
      JSON.stringify({
        version: 2,
        state: { entries: [makeEntry({ id: "citation-stash", prompt })] },
      }),
    );
    const restored = usePromptStashStore.getState().takeEntry("citation-stash").entry;
    expect(restored?.prompt).toBe(prompt);
    expect(
      collectAssistantCitations(restored?.prompt ?? "").map((entry) => entry.citation),
    ).toEqual([citation]);
    expect(usePromptStashStore.getState().takeEntry("citation-stash").entry).toBeNull();
  });

  it("evicts the oldest entry past the cap and returns it", () => {
    const store = usePromptStashStore.getState();
    for (let index = 0; index < MAX_STASH_ENTRIES; index += 1) {
      expect(store.stashEntry(makeEntry({ id: `entry-${index}` })).evicted).toBeNull();
    }
    const { evicted } = store.stashEntry(makeEntry({ id: "overflow" }));
    expect(evicted?.id).toBe("entry-0");
    const entries = usePromptStashStore.getState().entries;
    expect(entries).toHaveLength(MAX_STASH_ENTRIES);
    expect(entries[0]?.id).toBe("overflow");

    // A stash whose surrounding step fails is undone, and the oldest entry comes back.
    store.undoStash("overflow", evicted);
    const undone = usePromptStashStore.getState().entries;
    expect(undone).toHaveLength(MAX_STASH_ENTRIES);
    expect(undone[0]?.id).toBe(`entry-${MAX_STASH_ENTRIES - 1}`);
    expect(undone.at(-1)?.id).toBe("entry-0");
  });

  // regression: #4787 stashed prompts were lost when switching providers
  it("distinguishes a memory-only write (written, not durable) from a failed one", () => {
    const store = usePromptStashStore.getState();
    const result = store.stashEntry(makeEntry({ id: "memory-only" }));
    expect(result.written).toBe(true);
    expect(result.durable).toBe(false);
    expect(usePromptStashStore.getState().entries.map((entry) => entry.id)).toEqual([
      "memory-only",
    ]);
  });

  it("still reads entries saved with inline images and dropped-image names", () => {
    const legacy = {
      ...makeEntry({ id: "legacy" }),
      attachments: [
        {
          id: "img-inline",
          name: "inline.webp",
          mimeType: "image/webp",
          sizeBytes: 12,
          dataUrl: "data:image/webp;base64,BBBB",
        },
      ],
      droppedImageNames: ["too-large.png"],
      unreadableImageNames: ["unreadable.png"],
      pendingImageCount: 0,
    };
    writePromptStashStorageForTest(JSON.stringify({ version: 2, state: { entries: [legacy] } }));

    expect(usePromptStashStore.getState().takeEntry("legacy").entry).toMatchObject({
      attachments: [{ id: "img-inline", name: "inline.webp" }],
      droppedImageNames: ["too-large.png"],
      unreadableImageNames: ["unreadable.png"],
    });
  });

  it("keeps file references and media metadata without storing their contents", () => {
    const media = [
      {
        type: "image" as const,
        id: "img-1",
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 9,
      },
      {
        type: "file" as const,
        id: "doc-1",
        name: "notes.md",
        mimeType: "text/markdown",
        sizeBytes: 4,
      },
    ];
    const file = {
      id: "file-1",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      attachmentId: "pending-report-pdf",
      environmentId: EnvironmentId.make("environment-1"),
    };

    writePromptStashStorageForTest(
      JSON.stringify({
        version: 2,
        state: { entries: [{ ...makeEntry({ id: "with-file" }), files: [file], media }] },
      }),
    );

    expect(usePromptStashStore.getState().entries[0]).toMatchObject({ files: [file], media });
  });

  it("ignores an unreadable v1 payload seeded under the current key", () => {
    writePromptStashStorageForTest(
      JSON.stringify({
        version: 1,
        state: { queuesByScopeKey: { "provider:claudeAgent": [] } },
      }),
    );
    expect(usePromptStashStore.getState().entries).toEqual([]);
  });
});

describe("prompt stash context records", () => {
  it("restores the records behind a persisted prompt's chips", () => {
    const records = [
      {
        version: 1 as const,
        contextId: "ctx-1" as never,
        kind: "terminal" as const,
        label: "Terminal 1 line 4",
        terminalId: "default",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "boom",
      },
    ];
    writePromptStashStorageForTest(
      JSON.stringify({
        version: 2,
        state: {
          entries: [
            {
              id: "entry-records",
              createdAt: "2026-01-01T00:00:00.000Z",
              prompt: "see [Terminal 1 line 4](t3-context://v1/terminal/ctx-1)",
              attachments: [],
              droppedImageNames: [],
              records,
            },
          ],
        },
      }),
    );
    const taken = usePromptStashStore.getState().takeEntry("entry-records");
    expect(taken.entry?.records).toEqual(records);
  });
});
