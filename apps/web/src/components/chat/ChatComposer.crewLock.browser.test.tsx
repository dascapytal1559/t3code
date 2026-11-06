import { createMemoryHistory } from "@tanstack/react-router";
import type { ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform takes seconds; keep it out of the test.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { act, render } from "../../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

// Desktop-sized, so the sidebar shows beside the chat.
await page.viewport(1400, 900);

it("a FirstMate crewmate opens locked until Type anyway, and its card drops the branch", async () => {
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
  const unlock = page.getByRole("button", { name: "Type anyway" });

  await expect.element(unlock).toBeVisible();
  await expect.element(editor).toHaveAttribute("contenteditable", "false");

  // Every fixture records branch "main"; only the card outside FirstMate's group shows it.
  const cardText = (threadId: ThreadId) =>
    document.querySelector(`[data-thread-item="${ENVIRONMENT_ID}:${threadId}"]`)?.textContent;
  await vi.waitFor(() => expect(cardText(plain.id)).toContain("main"));
  expect(cardText(crew.id)).not.toContain("main");
  expect(cardText(coordinator.id)).not.toContain("main");

  await userEvent.click(unlock);
  await expect.element(unlock).not.toBeInTheDocument();
  await expect.element(editor).toHaveAttribute("contenteditable", "true");
  await userEvent.type(editor, "on purpose");
  await expect.element(editor).toHaveTextContent("on purpose");

  // FirstMate's own thread and an ordinary thread are never locked.
  for (const other of [coordinator.id, plain.id]) {
    await open(other);
    await expect.element(editor).toHaveAttribute("contenteditable", "true");
    await expect.element(unlock).not.toBeInTheDocument();
  }

  // Leaving the crewmate locked it again.
  await open(crew.id);
  await expect.element(unlock).toBeVisible();
  await expect.element(editor).toHaveAttribute("contenteditable", "false");
});
