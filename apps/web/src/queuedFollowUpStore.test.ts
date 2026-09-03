import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  MAX_QUEUED_FOLLOW_UPS,
  queuedFollowUpPreview,
  useQueuedFollowUpStore,
} from "./queuedFollowUpStore";

function emptyDraft(prompt: string) {
  return {
    prompt,
    images: [],
    files: [],
    persistedAttachments: [],
    terminalContexts: [],
    elementContexts: [],
    previewAnnotations: [],
    reviewComments: [],
  };
}

describe("queued follow-up store", () => {
  afterEach(() => {
    useQueuedFollowUpStore.setState({ itemsByThreadKey: {} });
  });

  it("enqueues and removes follow-ups per thread", () => {
    const result = useQueuedFollowUpStore
      .getState()
      .enqueue("env:thread-a", emptyDraft("then tests"));
    expect("item" in result).toBe(true);
    if (!("item" in result)) return;
    expect(useQueuedFollowUpStore.getState().itemsByThreadKey["env:thread-a"]?.[0]?.prompt).toBe(
      "then tests",
    );

    useQueuedFollowUpStore.getState().remove("env:thread-a", result.item.id);
    expect(useQueuedFollowUpStore.getState().itemsByThreadKey["env:thread-a"]).toBeUndefined();
  });

  it("caps the queue", () => {
    for (let index = 0; index < MAX_QUEUED_FOLLOW_UPS; index += 1) {
      const result = useQueuedFollowUpStore
        .getState()
        .enqueue("env:thread-a", emptyDraft(`item ${index}`));
      expect("item" in result).toBe(true);
    }
    expect(
      useQueuedFollowUpStore.getState().enqueue("env:thread-a", emptyDraft("overflow")),
    ).toEqual({ error: "full" });
  });

  it("clears only the matching environment", () => {
    useQueuedFollowUpStore.getState().enqueue("env-1:thread-a", emptyDraft("keep-me"));
    useQueuedFollowUpStore.getState().enqueue("env-2:thread-b", emptyDraft("drop-me"));
    useQueuedFollowUpStore.getState().clearEnvironment(EnvironmentId.make("env-2"));
    expect(useQueuedFollowUpStore.getState().itemsByThreadKey["env-1:thread-a"]?.length).toBe(1);
    expect(useQueuedFollowUpStore.getState().itemsByThreadKey["env-2:thread-b"]).toBeUndefined();
  });

  it("previews prompt text, then attachment names", () => {
    expect(queuedFollowUpPreview({ prompt: "  fix types  ", images: [], files: [] })).toBe(
      "fix types",
    );
    expect(
      queuedFollowUpPreview({
        prompt: " ",
        images: [{ name: "shot.png" } as never],
        files: [],
      }),
    ).toBe("shot.png");
  });
});
