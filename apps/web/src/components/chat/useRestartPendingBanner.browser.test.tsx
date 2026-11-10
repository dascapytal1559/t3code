import { RegistryProvider } from "@effect/atom-react";
import { EnvironmentId, type RestartRequest } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const PRIMARY = EnvironmentId.make("environment-primary");
const REMOTE = EnvironmentId.make("environment-remote");

const state = vi.hoisted(() => ({
  request: null as RestartRequest | null,
  cancel: vi.fn(),
  toast: vi.fn(),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    ...actual,
    primaryRestartRequestAtom: Atom.make(() => state.request),
    serverEnvironment: {
      ...actual.serverEnvironment,
      cancelRestartRequest: {
        ...actual.serverEnvironment.cancelRestartRequest,
        permissionAtom: () => allowed,
      },
    },
  };
});
vi.mock(import("../../state/primaryEnvironment"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await original()),
    primaryEnvironmentIdAtom: Atom.make(EnvironmentId.make("environment-primary")),
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.cancel) as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } };
});

import "~/index.css";
import { render } from "../../../test/render";
import { ComposerBannerStack } from "./ComposerBannerStack";
import { useRestartPendingBanner } from "./useRestartPendingBanner";

function setup(request: RestartRequest | null) {
  state.request = request;
  state.cancel.mockReset();
  state.toast.mockReset();
}

function Composer(props: { readonly environmentId: EnvironmentId }) {
  const banner = useRestartPendingBanner(props.environmentId);
  return <ComposerBannerStack items={banner === null ? [] : [banner]} />;
}

const renderComposer = (environmentId: EnvironmentId) =>
  render(
    <RegistryProvider>
      <Composer environmentId={environmentId} />
    </RegistryProvider>,
  );

const REQUEST = {
  reason: "install build 0.1.8",
  requestedBy: "Release lead",
  requestedAt: "2026-11-10T00:00:00.000Z",
} as unknown as RestartRequest;

it("shows the pending restart above the primary environment's composer only", async () => {
  setup(REQUEST);
  {
    await using screen = await renderComposer(PRIMARY);
    await expect
      .element(screen.getByText("T3 will restart when running turns finish"))
      .toBeVisible();
    await expect
      .element(
        screen.getByText("install build 0.1.8. New messages queue and send after the restart."),
      )
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Dismiss warning" }))
      .not.toBeInTheDocument();
  }
  {
    await using screen = await renderComposer(REMOTE);
    expect(screen.container.textContent).toBe("");
  }
});

it("cancels the restart, waiting on the request and reporting a failure", async () => {
  setup(REQUEST);
  let resolve: (result: unknown) => void = () => {};
  state.cancel.mockReturnValue(new Promise((settle) => (resolve = settle)));
  await using screen = await renderComposer(PRIMARY);
  const button = screen.getByRole("button", { name: "Cancel restart" });

  await userEvent.click(button);
  expect(state.cancel).toHaveBeenCalledWith({ environmentId: PRIMARY, input: {} });
  await expect.element(button).toBeDisabled();

  resolve(AsyncResult.failure(Cause.fail(new Error("Not allowed"))));
  await expect.element(button).toBeEnabled();
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({ type: "error", title: "Could not cancel the restart" }),
  );
});
