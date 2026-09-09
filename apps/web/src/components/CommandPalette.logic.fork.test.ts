// Fork: import a Codex or Claude session by id (FORK_FEATURES.md). Covers the
// palette's recognition of a pasted session reference.
import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

import {
  resolveAgentSessionImportTargets,
  type AgentSessionImportEnvironmentOption,
} from "./CommandPalette.logic";

const CODEX_ID = "01a07bb0-b316-7bd2-8074-aacf1e1d1422";

const environment = (
  id: string,
  overrides: Partial<AgentSessionImportEnvironmentOption> = {},
): AgentSessionImportEnvironmentOption => ({
  environmentId: EnvironmentId.make(id),
  label: id,
  isConnected: true,
  supportsImport: true,
  ...overrides,
});

describe("resolveAgentSessionImportTargets", () => {
  it("offers every connected environment whose server can import by id", () => {
    const targets = resolveAgentSessionImportTargets({
      query: `codex://threads/${CODEX_ID}`,
      isInSubmenu: false,
      environments: [
        environment("local"),
        environment("offline", { isConnected: false }),
        environment("old-server", { supportsImport: false }),
        environment("remote"),
      ],
    });

    expect(targets).toEqual({
      reference: { source: "codex", providerSessionId: CODEX_ID },
      environments: [environment("local"), environment("remote")],
    });
  });

  it("stays out of ordinary searches, submenus, and unsupported environments", () => {
    expect(
      resolveAgentSessionImportTargets({
        query: "new thread",
        isInSubmenu: false,
        environments: [environment("local")],
      }),
    ).toBeNull();
    expect(
      resolveAgentSessionImportTargets({
        query: CODEX_ID,
        isInSubmenu: true,
        environments: [environment("local")],
      }),
    ).toBeNull();
    expect(
      resolveAgentSessionImportTargets({
        query: CODEX_ID,
        isInSubmenu: false,
        environments: [environment("old-server", { supportsImport: false })],
      }),
    ).toBeNull();
  });
});
