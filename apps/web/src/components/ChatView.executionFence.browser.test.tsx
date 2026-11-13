import { createMemoryHistory } from "@tanstack/react-router";
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
  dispatchedCommands,
  installFakeEnvironment,
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

await page.viewport(1400, 900);

it("a thread FirstMate fenced says so, and Resume lifts the fence", async () => {
  const executionFence = {
    label: "task-1",
    worktreePath: null,
    fencedAt: "2026-11-13T00:00:00.000Z",
  };
  const coordinator = threadWithHistory("fence-coordinator", 1);
  const crew = { ...threadWithHistory("fenced-crew", 1), crewOf: coordinator.id, executionFence };
  const fenced = { ...threadWithHistory("fenced-thread", 1), executionFence };
  // Accepted, so the visit sent on opening a thread does not hold the lift behind it.
  using _environment = installFakeEnvironment([coordinator, crew, fenced], {
    acceptCommands: true,
  });
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
  const paused = page.getByText("Paused by FirstMate", { exact: true });
  const resume = page.getByRole("button", { name: "Resume", exact: true });

  // A worker has no composer, so the notice stands above its run controls.
  await expect.element(page.getByText(`Answer 0 for ${crew.id}.`)).toBeVisible();
  await expect.element(page.getByTestId("composer-editor")).not.toBeInTheDocument();
  await expect.element(paused).toBeVisible();

  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: fenced.id },
    }),
  );
  await expect.element(page.getByText(`Answer 0 for ${fenced.id}.`)).toBeVisible();
  await expect.element(paused).toBeVisible();
  await resume.click();
  await vi.waitFor(() =>
    expect(dispatchedCommands().at(-1)).toMatchObject({
      type: "thread.execution-fence.lift",
      threadId: fenced.id,
    }),
  );
  await expect.element(paused).not.toBeInTheDocument();
});
