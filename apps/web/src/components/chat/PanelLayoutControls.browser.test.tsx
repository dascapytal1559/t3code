import "~/index.css";

import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { PanelLayoutControls, WorkspaceTitlebarControls } from "./PanelLayoutControls";

function controls(options: { rightPanelOpen: boolean; maximized: boolean }) {
  return (
    <WorkspaceTitlebarControls
      showMaximizeControl
      rightPanelOpen={options.rightPanelOpen}
      animationsActive={false}
      maximized={options.maximized}
      onToggleMaximized={() => undefined}
    >
      <PanelLayoutControls
        showThreadPanelControl={!options.rightPanelOpen}
        terminalAvailable
        terminalOpen={false}
        terminalShortcutLabel={null}
        threadPanelOpen={false}
        threadPanelPresentation="inline"
        threadPanelShortcutLabel={null}
        rightPanelAvailable
        rightPanelOpen={options.rightPanelOpen}
        rightPanelShortcutLabel={null}
        onToggleTerminal={() => undefined}
        onToggleThreadPanel={() => undefined}
        onToggleRightPanel={() => undefined}
      />
    </WorkspaceTitlebarControls>
  );
}

function rect(screen: Awaited<ReturnType<typeof render>>, name: string) {
  return screen.getByRole("button", { name, exact: true }).element().getBoundingClientRect();
}

describe("WorkspaceTitlebarControls", () => {
  it.each([
    { maximized: false, name: "Maximize panel" },
    { maximized: true, name: "Restore panel size" },
  ])("puts the $name toggle right of every other control", async ({ maximized, name }) => {
    await using screen = await render(controls({ rightPanelOpen: true, maximized }));

    const maximize = rect(screen, name);
    for (const other of ["Toggle terminal drawer", "Toggle right panel"]) {
      expect(rect(screen, other).right).toBeLessThanOrEqual(maximize.left);
    }
  });

  it("parks the hidden toggle left of the controls, clear of the visible ones", async () => {
    await using screen = await render(controls({ rightPanelOpen: false, maximized: false }));

    const hidden = screen
      .getByRole("button", { name: "Maximize panel", exact: true, includeHidden: true })
      .element()
      .getBoundingClientRect();
    for (const other of ["Toggle thread details panel", "Toggle terminal drawer"]) {
      expect(hidden.right).toBeLessThanOrEqual(rect(screen, other).left);
    }
  });
});
