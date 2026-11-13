import { RegistryProvider } from "@effect/atom-react";
import {
  EnvironmentId,
  ThreadId,
  type ScopedThreadRef,
  type StoredDecision,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import type { CaptainCard } from "../sidebar/coordinatorGroup.logic";

const state = vi.hoisted(() => ({
  act: vi.fn(),
  archiveThread: vi.fn(),
}));

vi.mock(import("../../state/orchestration"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    ...actual,
    orchestrationEnvironment: {
      ...actual.orchestrationEnvironment,
      replyToKeptThread: {
        ...actual.orchestrationEnvironment.replyToKeptThread,
        permissionAtom: () => allowed,
      },
    },
  };
});
vi.mock(import("../sidebar/useCaptainCards"), async (original) => ({
  ...(await original()),
  useCaptainItemAct: () => state.act,
}));
vi.mock(import("../../hooks/useThreadActions"), async (original) => ({
  ...(await original()),
  useThreadActions: (() => ({ archiveThread: state.archiveThread })) as never,
}));

import { render } from "../../../test/render";
import { KeptThreadReply } from "./KeptThreadReply";

const environmentId = EnvironmentId.make("environment-local");
const threadId = ThreadId.make("thread:probe");
const threadRef: ScopedThreadRef = { environmentId, threadId };

function setup() {
  state.act.mockReset().mockResolvedValue(true);
  state.archiveThread.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
}

const card = (
  overrides: { readonly finished?: boolean; readonly snoozed?: CaptainCard["snoozed"] } = {},
): CaptainCard => {
  const item: StoredDecision = {
    id: "media-archive-build",
    title: "Build the importer now?",
    question: "Build the importer now?",
    options: [],
    entries: [],
    revision: 2,
    thread: { id: threadId, finished: overrides.finished ?? false },
  };
  return { environmentId, item, label: "Needs you", snoozed: overrides.snoozed ?? null };
};

const renderReply = (captainCard: CaptainCard) =>
  render(
    <RegistryProvider>
      <KeptThreadReply threadRef={threadRef} captainCard={captainCard} />
    </RegistryProvider>,
  );

it("snoozes with no date on a tap, picks a return time from T3's presets, and only asks FirstMate to archive a running worker", async () => {
  setup();
  const live = card();
  await using screen = await renderReply(live);
  await userEvent.click(screen.getByRole("button", { name: "Snooze", exact: true }));
  expect(state.act).toHaveBeenLastCalledWith(live, { type: "snooze", until: null });

  await userEvent.click(screen.getByRole("button", { name: "Snooze until…" }));
  const preset = screen.getByRole("menuitem").first();
  await expect.element(preset).toBeVisible();
  await userEvent.click(preset);
  const [, picked] = state.act.mock.lastCall ?? [];
  expect(picked).toMatchObject({ type: "snooze" });
  // A preset is a return time, not "no date".
  expect(Number.isNaN(Date.parse(picked.until))).toBe(false);

  await userEvent.click(screen.getByRole("button", { name: "Archive" }));
  expect(state.act).toHaveBeenLastCalledWith(live, { type: "archive" });
  expect(state.archiveThread).not.toHaveBeenCalled();
});

it("archives a finished worker's thread, and brings a snoozed item back", async () => {
  setup();
  {
    await using screen = await renderReply(card({ finished: true }));
    await userEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(state.archiveThread).toHaveBeenCalledWith(threadRef);
    expect(state.act).not.toHaveBeenCalled();
  }
  const snoozed = card({ snoozed: { at: "2026-11-12T00:00:00.000Z", until: null } });
  await using screen = await renderReply(snoozed);
  await expect
    .element(screen.getByRole("button", { name: "Snooze", exact: true }))
    .not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Bring back" }));
  expect(state.act).toHaveBeenLastCalledWith(snoozed, { type: "unsnooze" });
});
