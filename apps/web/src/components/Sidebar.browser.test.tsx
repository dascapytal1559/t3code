import { DEFAULT_CLIENT_SETTINGS, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useProjects, useQuietThreadShells, useServerConfigs } from "../state/entities";
import { useEnvironmentScope } from "../state/session";
import { makeThreadFixture } from "../test-fixtures";
import type { Project } from "../types";
import Sidebar from "./Sidebar";
import { SidebarProvider } from "./ui/sidebar";

vi.mock("../state/entities", { spy: true });
vi.mock("../state/session", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../commandPaletteBus", () => ({
  openCommandPalette: vi.fn(),
  isCommandPaletteOpen: () => false,
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

function project(id: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make("local"),
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

describe("sidebar header new thread", () => {
  it.each([
    { mode: "normal", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: true, picker: false },
    { mode: "boring", count: 1, shift: false, picker: false },
    { mode: "legacy", count: 2, shift: false, picker: false },
  ] as const)("$mode sidebar, $count projects, shift=$shift: picker=$picker", async (scenario) => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      boringSidebarEnabled: scenario.mode === "boring",
      legacySidebarEnabled: scenario.mode === "legacy",
    });
    const projects = [project("active"), project("idle")].slice(0, scenario.count);
    const currentProjectRef = {
      environmentId: projects[0]!.environmentId,
      projectId: projects[0]!.id,
    };
    const startThread = vi.fn().mockResolvedValue(null);
    vi.mocked(useProjects).mockReturnValue(projects);
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: currentProjectRef,
      handleNewThread: startThread,
      routeDraftId: null,
      routeThreadRef: null,
    });
    vi.mocked(openCommandPalette).mockClear();
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "New thread", exact: true }), {
      modifiers: scenario.shift ? ["Shift"] : [],
    });

    if (scenario.picker) {
      expect(openCommandPalette).toHaveBeenCalledExactlyOnceWith({ open: "new-thread-in" });
      expect(startThread).not.toHaveBeenCalled();
    } else {
      expect(openCommandPalette).not.toHaveBeenCalled();
      expect(startThread).toHaveBeenCalledExactlyOnceWith(currentProjectRef);
    }
  });
});

describe("sidebar crew cards", () => {
  it("offers Settle on the FirstMate and crew cards, and Snooze only on other cards", async () => {
    using stack = new DisposableStack();
    localStorage.setItem("t3code:sidebar:crew-expanded", "true");
    stack.defer(() => localStorage.removeItem("t3code:sidebar:crew-expanded"));
    const home = project("home");
    const scope = { environmentId: home.environmentId, projectId: home.id };
    const coordinatorId = ThreadId.make("firstmate");
    vi.mocked(useEnvironmentScope).mockReturnValue(true);
    vi.mocked(useProjects).mockReturnValue([home]);
    vi.mocked(useServerConfigs).mockReturnValue(new Map([[home.environmentId, {} as never]]));
    vi.mocked(useQuietThreadShells).mockReturnValue([
      { ...makeThreadFixture({ ...scope, id: coordinatorId, title: "Main" }), coordinator: true },
      {
        ...makeThreadFixture({ ...scope, id: ThreadId.make("crew"), title: "Crewmate" }),
        crewOf: coordinatorId,
      },
      makeThreadFixture({ ...scope, id: ThreadId.make("plain"), title: "Ordinary" }),
    ]);
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: null,
      handleNewThread: vi.fn(),
      routeDraftId: null,
      routeThreadRef: null,
    });
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    const card = (title: string) =>
      screen.getByTestId("sidebar-row-card").filter({ hasText: title });
    for (const title of ["Main", "Crewmate", "Ordinary"]) {
      await expect
        .element(card(title).getByRole("button", { name: "Settle thread" }))
        .toBeInTheDocument();
    }
    await expect
      .element(card("Ordinary").getByRole("button", { name: "Snooze thread" }))
      .toBeInTheDocument();
    for (const title of ["Main", "Crewmate"]) {
      await expect
        .element(card(title).getByRole("button", { name: "Snooze thread" }))
        .not.toBeInTheDocument();
    }
  });
});
