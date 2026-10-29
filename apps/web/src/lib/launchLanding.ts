import type { AnyRouter } from "@tanstack/react-router";

/**
 * One automatic landing choice per page load, made only while the page is still on the index it
 * loaded on. A page that loaded on any other URL, or has left the index since, never gets one, so
 * deep links and later returns to the index stay as they are.
 */
export function createLaunchLanding() {
  let open = true;
  return {
    observe(pathname: string) {
      if (pathname !== "/") open = false;
    },
    claim(): boolean {
      const claimed = open;
      open = false;
      return claimed;
    },
  };
}

const launchLanding = createLaunchLanding();

export function startLaunchLandingTracking(router: AnyRouter): () => void {
  const observe = () => launchLanding.observe(router.state.location.pathname);
  observe();
  return router.subscribe("onResolved", observe);
}

export const claimLaunchLanding = launchLanding.claim;
