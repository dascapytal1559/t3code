import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { saveUsagePagePreferences } from "../usage/usagePagePreferences";
import { SidebarUsageMini } from "./SidebarUsageMini";

const state = vi.hoisted(() => ({ presentations: new Map() as LimitPresentations }));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => state.presentations,
}));

const checkedAt = "2026-11-06T00:00:00.000Z";
const resetsAt = "2026-11-10T00:00:00.000Z";

function window(id: string, label: string, usedPercent: number): ServerProviderUsageWindow {
  return {
    id,
    kind: id === "five_hour" ? "session" : "weekly",
    label,
    usedPercent,
    resetsAt,
    windowDurationMins: id === "five_hour" ? 300 : 10_080,
  };
}

function provider(
  instanceId: string,
  driver: "codex" | "claudeAgent",
  email: string,
  windows: ServerProviderUsageWindow[],
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    displayName: instanceId,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated", email },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt, windows },
  };
}

const codex = provider("Codex", "codex", "a@example.com", [window("weekly", "Weekly", 8)]);

function setup(providers: ServerProvider[] | null) {
  saveUsagePagePreferences({ metric: "limits", windowDays: 30, hiddenProviders: [] });
  state.presentations = new Map([
    [
      EnvironmentId.make("local"),
      {
        entry: { target: { label: "Local" } },
        serverConfig: providers === null ? null : { providers },
      },
    ],
  ]);
}

const ui = () => (
  <SidebarProvider defaultOpen>
    <SidebarUsageMini />
  </SidebarProvider>
);

describe("SidebarUsageMini", () => {
  it("shows nothing until an environment reports limits", async () => {
    setup(null);
    await using screen = await render(ui());
    expect(screen.container.querySelector("[data-sidebar-usage]")).toBeNull();
  });

  it("leaves out a provider muted on the Usage page, and brings it back when unmuted", async () => {
    setup([
      codex,
      provider("Claude", "claudeAgent", "b@example.com", [window("seven_day", "Weekly", 47)]),
    ]);
    saveUsagePagePreferences({ metric: "limits", windowDays: 30, hiddenProviders: ["codex"] });
    await using screen = await render(ui());
    await expect
      .element(screen.getByRole("button", { name: "Usage: Claude 53% left" }))
      .toBeVisible();

    await act(() =>
      saveUsagePagePreferences({ metric: "limits", windowDays: 30, hiddenProviders: [] }),
    );
    await expect
      .element(screen.getByRole("button", { name: "Usage: Codex 92% left, Claude 53% left" }))
      .toBeVisible();
  });

  it("draws a pooled provider as one combined weekly bar and skips session and model rows", async () => {
    setup([
      provider("Claude", "claudeAgent", "one@example.com", [
        window("five_hour", "Session", 50),
        window("seven_day", "Weekly", 91),
        window("seven_day_fable", "Weekly · Fable", 47),
      ]),
      provider("Claude2", "claudeAgent", "two@example.com", [
        window("five_hour", "Session", 10),
        window("seven_day", "Weekly", 3),
        window("seven_day_fable", "Weekly · Fable", 6),
      ]),
    ]);
    await using screen = await render(ui());
    await expect
      .element(screen.getByRole("button", { name: "Usage: Claude 53% left" }))
      .toBeVisible();
    expect(screen.container.querySelectorAll("[data-usage-segment]")).toHaveLength(1);
  });
});
