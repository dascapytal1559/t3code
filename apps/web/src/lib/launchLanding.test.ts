import { describe, expect, it } from "vite-plus/test";

import { createLaunchLanding } from "./launchLanding";

describe("createLaunchLanding", () => {
  it("grants one landing to a page that loaded on the index", () => {
    const landing = createLaunchLanding();
    landing.observe("/");
    expect(landing.claim()).toBe(true);
    expect(landing.claim()).toBe(false);
  });

  it("grants none to a page that loaded on a deep link", () => {
    const landing = createLaunchLanding();
    landing.observe("/environment-local/thread-1");
    landing.observe("/");
    expect(landing.claim()).toBe(false);
  });

  it("grants none once the page has left the index", () => {
    const landing = createLaunchLanding();
    landing.observe("/");
    landing.observe("/settings");
    landing.observe("/");
    expect(landing.claim()).toBe(false);
  });
});
