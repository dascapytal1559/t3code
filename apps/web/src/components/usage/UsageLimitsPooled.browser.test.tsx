import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import "../../index.css";
import { render } from "../../../test/render";
import { UsageLimitsPooled } from "./UsageLimitsPooled";

const checkedAt = "2026-10-25T16:00:00.000Z";

function managedChatGpt(instanceId: string, displayName: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName,
    enabled: true,
    installed: true,
    version: "0.164.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
      externalUsage: { label: "ChatGPT usage", url: CHATGPT_USAGE_URL },
    },
  };
}

function claude(instanceId: string, weekly: number, fable: number): ServerProvider {
  const window = (id: string, label: string, usedPercent: number): ServerProviderUsageWindow => ({
    id,
    kind: "weekly",
    label,
    usedPercent,
    resetsAt: "2026-10-30T16:00:00.000Z",
    windowDurationMins: 10_080,
  });
  return {
    ...managedChatGpt(instanceId, instanceId),
    driver: ProviderDriverKind.make("claudeAgent"),
    auth: { status: "authenticated", email: `${instanceId}@example.com` },
    usageLimits: {
      checkedAt,
      windows: [
        window("seven_day", "Weekly", weekly),
        window("seven_day_fable", "Weekly · Fable", fable),
      ],
    },
  };
}

describe("UsageLimitsPooled model-scoped weekly card", () => {
  it("takes less room than the account-wide weekly card above it and keeps its numbers", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: { providers: [claude("Claude1", 22, 14), claude("Claude2", 0, 0)] },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );
    const card = (label: string) =>
      screen.getByText(label, { exact: true }).element().closest("div.rounded-lg")!;

    await expect.element(screen.getByText("Weekly · Fable")).toBeVisible();
    const main = card("Weekly").getBoundingClientRect();
    const scoped = card("Weekly · Fable").getBoundingClientRect();
    expect(scoped.height).toBeLessThan(main.height * 0.9);
    expect(scoped.width).toBe(main.width);
    expect(card("Weekly · Fable").textContent).toMatch(/\d+%left/);
  });
});

describe("UsageLimitsPooled ChatGPT usage card", () => {
  it("names the managed connections it covers", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              managedChatGpt("chatgpt_work", "ChatGPT Work"),
              managedChatGpt("chatgpt_personal", "ChatGPT Personal"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect
      .element(screen.getByText("ChatGPT Work on Desk, ChatGPT Personal on Desk"))
      .toBeVisible();
    await expect
      .element(screen.getByText("View usage in ChatGPT with your connected account."))
      .toBeVisible();
  });
});
