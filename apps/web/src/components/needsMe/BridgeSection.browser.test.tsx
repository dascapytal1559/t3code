import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { BridgeSection, useObjectivesPinned } from "./BridgeSection";

function Bridge() {
  const [pinned, setPinned] = useObjectivesPinned();
  return (
    <>
      <BridgeSection
        id="objectives"
        title="Objectives"
        count={1}
        pin={{ pinned, onToggle: () => setPinned(!pinned) }}
      >
        <p>Ship the Bridge</p>
      </BridgeSection>
      <BridgeSection id="rules" title="Rules" count={0}>
        <p>No rules</p>
      </BridgeSection>
    </>
  );
}

it("remembers each section's collapse and the Objectives pin across reloads", async () => {
  window.localStorage.clear();
  using _storage = { [Symbol.dispose]: () => window.localStorage.clear() };
  {
    await using screen = await render(<Bridge />);
    const objectives = screen.getByRole("button", { name: "Objectives · 1" });
    // A new client starts with Objectives pinned open.
    await expect.element(objectives).toBeDisabled();
    await expect.element(screen.getByText("Ship the Bridge")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Rules · 0" }));
    await expect.element(screen.getByText("No rules")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Unpin Objectives" }));
    await userEvent.click(objectives);
    await expect.element(screen.getByText("Ship the Bridge")).not.toBeInTheDocument();
  }

  await using screen = await render(<Bridge />);
  await expect
    .element(screen.getByRole("button", { name: "Rules · 0" }))
    .toHaveAttribute("aria-expanded", "false");
  await expect
    .element(screen.getByRole("button", { name: "Objectives · 1" }))
    .toHaveAttribute("aria-expanded", "false");
  // Pinning opens a collapsed Objectives and keeps it open.
  await userEvent.click(screen.getByRole("button", { name: "Pin Objectives open" }));
  await expect.element(screen.getByText("Ship the Bridge")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Objectives · 1" })).toBeDisabled();
});
