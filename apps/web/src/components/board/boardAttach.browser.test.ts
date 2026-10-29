import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import {
  attachBoardImage,
  readBoardAttachTarget,
  startBoardAttachTargetTracking,
} from "./boardAttach";

const environmentId = EnvironmentId.make("board-environment");
const projectRef = scopeProjectRef(environmentId, ProjectId.make("board-project"));

// The draft store keeps attachments only once its storage confirms they were written.
const storage = vi.hoisted(() => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
  };
  vi.stubGlobal("localStorage", storage);
  return storage;
});

function setup(): Disposable {
  storage.clear();
  vi.stubGlobal("localStorage", storage);
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  return { [Symbol.dispose]: () => vi.unstubAllGlobals() };
}

// The tracker reads only the deepest match's params and the onResolved subscription.
function fakeRouter() {
  let params: Record<string, string> = {};
  const listeners = new Set<() => void>();
  const router = {
    state: {
      get matches() {
        return [{ params }];
      },
    },
    subscribe: (_event: string, listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as AnyRouter;
  const go = (next: Record<string, string>) => {
    params = next;
    for (const listener of listeners) listener();
  };
  return { router, go };
}

async function png() {
  const canvas = new OffscreenCanvas(40, 20);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No 2d context.");
  context.fillStyle = "#e03131";
  context.fillRect(0, 0, 40, 20);
  return canvas.convertToBlob({ type: "image/png" });
}

describe("board attach", () => {
  it("attaches the board PNG to the last draft on screen, not the board route", async () => {
    using _env = setup();
    const draftId = DraftId.make("board-draft");
    useComposerDraftStore
      .getState()
      .setProjectDraftThreadId(projectRef, draftId, { threadId: ThreadId.make("board-thread") });
    const { router, go } = fakeRouter();
    const stopTracking = startBoardAttachTargetTracking(router);
    go({ draftId });
    go({});
    stopTracking();

    expect(readBoardAttachTarget()).toBe(draftId);
    await attachBoardImage(draftId, await png());

    const draft = useComposerDraftStore.getState().getComposerDraft(draftId);
    expect(draft?.images.map(({ mimeType }) => mimeType)).toEqual(["image/png"]);
    expect(draft?.persistedAttachments.map(({ id }) => id)).toEqual(
      draft?.images.map(({ id }) => id),
    );
    expect(draft?.persistedAttachments[0]?.dataUrl).toMatch(/^data:image\/png;base64,/);
  });
});
