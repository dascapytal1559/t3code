import { createMemoryHistory } from "@tanstack/react-router";
import { NodeId, ProviderSessionId, RuntimeRequestId, type ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform takes seconds; keep it out of the test.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  emitThreadEvent,
  installFakeEnvironment,
  runningRun,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

// Desktop-sized, so the sidebar shows beside the chat.
await page.viewport(1400, 900);

it("a FirstMate worker shows no composer, only Stop while it runs and its approvals", async () => {
  const coordinator = threadWithHistory("crew-coordinator", 1);
  const crew = { ...threadWithHistory("crew-member", 1), crewOf: coordinator.id };
  const plain = threadWithHistory("plain-thread", 1);
  using _environment = installFakeEnvironment([coordinator, crew, plain]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${crew.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const open = async (threadId: ThreadId) => {
    await act(() =>
      router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: ENVIRONMENT_ID, threadId },
      }),
    );
    await expect.element(page.getByText(`Answer 0 for ${threadId}.`)).toBeVisible();
  };
  const editor = page.getByTestId("composer-editor");
  const stop = page.getByRole("button", { name: "Stop", exact: true });

  await expect.element(page.getByText(`Answer 0 for ${crew.id}.`)).toBeVisible();
  await expect.element(editor).not.toBeInTheDocument();
  await expect.element(stop).not.toBeInTheDocument();

  // Every fixture records branch "main"; only the card outside FirstMate's group shows it.
  const cardText = (threadId: ThreadId) =>
    document.querySelector(`[data-thread-item="${ENVIRONMENT_ID}:${threadId}"]`)?.textContent;
  await vi.waitFor(() => expect(cardText(plain.id)).toContain("main"));
  expect(cardText(crew.id)).not.toContain("main");
  expect(cardText(coordinator.id)).not.toContain("main");

  const live = runningRun(crew.id, "crew-live", 2, "crew-live-user");
  await act(() => emitThreadEvent(crew.id, { type: "run.created", payload: live }));
  await expect.element(stop).toBeVisible();
  await expect.element(editor).not.toBeInTheDocument();

  const approval = (resolved: boolean) =>
    emitThreadEvent(crew.id, {
      type: "runtime-request.updated",
      payload: {
        id: RuntimeRequestId.make("crew-approval"),
        nodeId: NodeId.make("crew-node"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command",
        status: resolved ? "resolved" : "pending",
        responseCapability: {
          type: "live",
          providerSessionId: ProviderSessionId.make("crew-session"),
        },
        createdAt: live.requestedAt,
        resolvedAt: resolved ? live.requestedAt : null,
      },
    });
  // An approval brings the box back, since its feedback goes through it.
  await act(() => approval(false));
  await expect.element(page.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
  await expect.element(editor).toBeVisible();

  await act(async () => {
    await approval(true);
    await emitThreadEvent(crew.id, {
      type: "run.updated",
      payload: { ...live, status: "completed", completedAt: live.requestedAt },
    });
  });
  await expect.element(editor).not.toBeInTheDocument();
  await expect.element(stop).not.toBeInTheDocument();

  // FirstMate's own thread and an ordinary thread keep their composer.
  for (const other of [coordinator.id, plain.id]) {
    await open(other);
    await expect.element(editor).toHaveAttribute("contenteditable", "true");
  }
});
