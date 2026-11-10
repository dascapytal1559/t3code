import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ObjectivesSection } from "./ObjectivesSection";

it("shows each objective as a collapsed title that expands to its description", async () => {
  window.localStorage.clear();
  using _storage = { [Symbol.dispose]: () => window.localStorage.clear() };
  await using screen = await render(
    <ObjectivesSection
      environmentId={EnvironmentId.make("env-1")}
      objectives={{
        markdown: "- **Ship the Bridge** — make it calm\n- **Rest**\n- **Write** — one post a week",
      }}
    />,
  );

  const ship = screen.getByRole("button", { name: "Ship the Bridge" });
  await expect.element(ship).toHaveAttribute("aria-expanded", "false");
  await expect.element(screen.getByText("make it calm")).not.toBeInTheDocument();

  await userEvent.click(ship);
  await expect.element(screen.getByText("make it calm")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Write" }));
  await expect.element(screen.getByText("make it calm")).toBeVisible();
  await expect.element(screen.getByText("one post a week")).toBeVisible();

  // An objective with no description is a plain title, not a button.
  await expect.element(screen.getByText("Rest")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Rest" })).not.toBeInTheDocument();
});
