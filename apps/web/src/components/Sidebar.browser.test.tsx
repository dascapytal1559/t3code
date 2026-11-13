import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ScopedThreadRef,
  type ServerProvider,
  type StoredDecision,
} from "@t3tools/contracts";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { makeThreadFixture } from "../test-fixtures";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { useProjects, useQuietThreadShells } from "../state/entities";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import type { Project } from "../types";
import Sidebar from "./Sidebar";
import { THREAD_JUMP_HINT_SHOW_DELAY_MS } from "./Sidebar.logic";
import { SortableThreadRow } from "./sidebar/SidebarThreadRow";
import { resolveCaptainCards } from "./sidebar/coordinatorGroup.logic";
import { useCaptainCards } from "./sidebar/useCaptainCards";
import { SidebarProvider } from "./ui/sidebar";

const providerState = vi.hoisted(() => ({
  providers: new Map<string, unknown>(),
  serverConfigs: new Map<string, unknown>(),
}));
vi.mock("./sidebar/useCaptainCards", { spy: true });
vi.mock("../state/entities", { spy: true });
vi.mock(import("../state/presentation"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const real = await original();
  return {
    ...real,
    environmentPresentations: {
      ...real.environmentPresentations,
      providersByEnvironmentAtom: Atom.make(() => providerState.providers),
      serverConfigsAtom: Atom.make(() => providerState.serverConfigs),
    },
  } as never;
});
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../hooks/useThreadRouteTarget", { spy: true });
vi.mock("./sidebar/SidebarThreadRow", { spy: true });
vi.mock(import("../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  // The desktop defaults: holding Mod alone already matches a thread jump.
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "mod+1", command: "thread.jump.1" },
    { key: "mod+2", command: "thread.jump.2" },
  ]);
  return { ...(await original()), primaryServerKeybindingsAtom: Atom.make(keybindings) };
});
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
  ] as const)("$mode sidebar, $count projects, shift=$shift: picker=$picker", async (scenario) => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      boringSidebarEnabled: scenario.mode === "boring",
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
      defaultProjectFallbackReady: true,
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

function threadShell(projectId: ProjectId, index: number): EnvironmentThreadShell {
  return makeThreadFixture({
    environmentId: EnvironmentId.make("local"),
    id: ThreadId.make(`thread-${index}`),
    projectId,
    title: `Thread ${index}`,
  });
}

describe("sidebar render isolation", () => {
  // regression: #33100 Cmd+J re-rendered every sidebar row, which took hundreds of ms with many threads
  it("does not re-render thread rows when a quick Mod shortcut opens and focuses the terminal", async () => {
    using stack = new DisposableStack();
    const activeProject = project("active");
    const threads = Array.from({ length: 5 }, (_, index) => threadShell(activeProject.id, index));
    const routeThreadRef: ScopedThreadRef = {
      environmentId: activeProject.environmentId,
      threadId: threads[0]!.id,
    };
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: routeThreadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef,
    });
    const terminal = document.createElement("div");
    terminal.dataset.terminalOwner = "drawer";
    const terminalInput = document.createElement("textarea");
    terminal.append(terminalInput);
    document.body.append(terminal);
    stack.defer(() => terminal.remove());
    stack.defer(() => useTerminalUiStateStore.getState().setTerminalOpen(routeThreadRef, false));
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    await expect.element(screen.getByText("Thread 4").first()).toBeInTheDocument();
    const rowRenders = () => vi.mocked(SortableThreadRow).mock.calls.length;

    using _timers = fakeTimers();
    const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
    const beforeShortcut = rowRenders();
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => useTerminalUiStateStore.getState().setTerminalOpen(routeThreadRef, true));
    await act(() => terminalInput.focus());
    await userEvent.keyboard(`{/${modifier}}`);
    await act(() => terminalInput.blur());
    expect(
      rowRenders() - beforeShortcut,
      "thread rows re-rendered while opening the terminal with a quick Mod shortcut",
    ).toBe(0);

    const jumpLabelsSince = (start: number) =>
      vi
        .mocked(SortableThreadRow)
        .mock.calls.slice(start)
        .map(([props]) => props.jumpLabel)
        .filter((label) => label !== null);
    const beforeHold = rowRenders();
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS));
    expect(jumpLabelsSince(beforeHold), "holding Mod showed no jump hints").toHaveLength(2);
    const beforeRelease = rowRenders();
    await userEvent.keyboard(`{/${modifier}}`);
    expect(rowRenders()).toBeGreaterThan(beforeRelease);
    expect(jumpLabelsSince(beforeRelease)).toEqual([]);
  });
});

describe("sidebar thread cards", () => {
  it("lead with the project icon, or the No project icon, instead of the model and account", async () => {
    const environmentId = EnvironmentId.make("local");
    const provider = (instanceId: string): ServerProvider => ({
      instanceId: ProviderInstanceId.make(instanceId),
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: instanceId,
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-11-06T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    });
    // Two Claude accounts, so the thread on the second would have drawn an account badge.
    providerState.providers = new Map([
      [environmentId, [provider("claudeAgent"), provider("claude2")]],
    ]);
    providerState.serverConfigs = new Map([
      [environmentId, { settings: { providerInstances: {} } }],
    ]);
    const withIcon = {
      ...project("persistent-agents"),
      title: "Persistent agents",
      projectIcon: { kind: "monogram", text: "PA", color: "pink" },
    } as const satisfies Project;
    const scratch = {
      ...project("scratch"),
      title: "No project",
      isScratch: true,
      projectIcon: { kind: "lucide", name: "message-square-dashed", color: "gray" },
    } as const satisfies Project;
    const threads = [
      makeThreadFixture({
        environmentId,
        id: ThreadId.make("pa"),
        projectId: withIcon.id,
        title: "Persistent agents",
        providerInstanceId: ProviderInstanceId.make("claude2"),
      }),
      makeThreadFixture({
        environmentId,
        id: ThreadId.make("garmin"),
        projectId: scratch.id,
        title: "Garmin setup",
        providerInstanceId: ProviderInstanceId.make("claude2"),
      }),
    ];
    vi.mocked(useProjects).mockReturnValue([withIcon, scratch]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "none" } as never);
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    const row = (threadId: string) =>
      document.querySelector<HTMLElement>(`[data-sidebar-row="local:${threadId}"]`);
    await expect.element(screen.getByText("Garmin setup").first()).toBeInTheDocument();
    expect(row("pa")?.dataset.testid).toBe("sidebar-row-card");
    expect(row("pa")?.querySelector("svg text")?.textContent).toBe("PA");
    await vi.waitFor(() =>
      expect(row("garmin")?.querySelector("svg.lucide-message-square-dashed")).not.toBeNull(),
    );
    // ProviderInstanceIcon's wrapper, which carries the account badge.
    expect(row("pa")?.querySelector(".isolate")).toBeNull();
    expect(row("garmin")?.querySelector(".isolate")).toBeNull();
  });
});

describe("FirstMate's items in the sidebar", () => {
  it("label worker cards Needs you or To read on the right, move snoozed ones to Snoozed, and offer no hover Snooze or Settle", async () => {
    const environmentId = EnvironmentId.make("local");
    providerState.providers = new Map();
    providerState.serverConfigs = new Map([
      [environmentId, { settings: { providerInstances: {} } }],
    ]);
    const home = project("firstmate");
    const shell = (id: string, title: string, extra: Partial<EnvironmentThreadShell> = {}) => ({
      ...makeThreadFixture({ environmentId, id: ThreadId.make(id), projectId: home.id, title }),
      ...extra,
    });
    const firstmate = ThreadId.make("firstmate");
    const crew = { crewOf: firstmate };
    const threads = [
      shell("firstmate", "Firstmate", { coordinator: true }),
      shell("probe", "Media archive probe", crew),
      shell("spec", "Captain surface spec", crew),
      shell("cap", "File size cap review", crew),
      shell("vision", "Agent messaging vision", crew),
      // A standing agent: an ordinary thread in its own project.
      shell("logger", "Logger"),
    ];
    const item = (id: string, threadId: string, extra: Partial<StoredDecision> = {}) => ({
      id,
      title: id,
      question: `${id}?`,
      options: [],
      entries: [],
      revision: 1,
      thread: { id: ThreadId.make(threadId), finished: false },
      ...extra,
    });
    const decisions = [
      item("media-archive-build", "probe"),
      item("captain-surface-spec", "spec", { kind: "read" }),
      item("cap-review", "cap", {
        snoozed: { at: "2026-11-12T00:00:00.000Z", until: "2099-11-21T09:00:00.000Z" },
      }),
      item("vision-read", "vision", {
        kind: "read",
        snoozed: { at: "2026-11-11T00:00:00.000Z", until: null },
      }),
    ];
    vi.mocked(useCaptainCards).mockReturnValue(
      resolveCaptainCards(
        [{ environmentId, state: { decisions, actions: [] } }],
        Date.parse("2026-11-13T12:00:00.000Z"),
      ),
    );
    vi.mocked(useProjects).mockReturnValue([home]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "none" } as never);
    // The crew tree and the Snoozed shelf start collapsed.
    using stack = new DisposableStack();
    for (const key of ["t3code:sidebar:crew-expanded", "t3code:sidebar:snoozed-expanded"]) {
      localStorage.setItem(key, "true");
      stack.defer(() => localStorage.removeItem(key));
    }
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const row = (threadId: string) =>
      document.querySelector<HTMLElement>(`[data-sidebar-row="local:${threadId}"]`);

    await expect.element(screen.getByText("Media archive probe").first()).toBeInTheDocument();
    await vi.waitFor(() => expect(row("probe")?.textContent).toContain("Needs you"));
    expect(row("spec")?.textContent).toContain("To read");
    // Snoozed items leave the crew for the Snoozed shelf, after its header, with no label.
    const snoozedHeader = screen.getByText("Snoozed", { exact: true }).element();
    for (const id of ["cap", "vision"]) {
      expect(
        snoozedHeader.compareDocumentPosition(row(id)!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    expect(row("cap")?.textContent).toMatch(/in \d/);
    expect(row("vision")?.textContent).not.toContain("To read");

    for (const id of ["probe", "logger"]) {
      await userEvent.hover(row(id)!);
      expect(row(id)?.querySelector('[aria-label="Snooze thread"]')).toBeNull();
      expect(row(id)?.querySelector('[aria-label="Settle thread"]')).toBeNull();
    }
  });
});
