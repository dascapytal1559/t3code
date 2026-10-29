import { CircleArrowUpIcon, ExternalLinkIcon } from "lucide-react";

import {
  UPSTREAM_RELEASE_REPOSITORY,
  type UpstreamReleaseNotice,
} from "../../state/upstreamRelease";
import { getDesktopUpdateReleaseUrl } from "../desktopUpdate.logic";
import { openDesktopUpdateReleaseNotes } from "../desktopUpdate.toast";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Informational only: this build has no update feed, so nothing installs from here. */
export function SidebarUpstreamRelease({ notice }: { readonly notice: UpstreamReleaseNotice }) {
  const { release, dismiss } = notice;
  const title = `T3 Code v${release.version} is out`;
  const releaseUrl = getDesktopUpdateReleaseUrl(release.version, UPSTREAM_RELEASE_REPOSITORY);

  return (
    <SidebarMenuItem className="ml-auto shrink-0">
      <Popover>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <button
                    type="button"
                    aria-label={title}
                    className="inline-flex size-8 cursor-pointer items-center justify-center rounded-full bg-sidebar-control-surface text-sidebar-foreground outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset"
                  >
                    <CircleArrowUpIcon className="size-4" />
                  </button>
                }
              />
            }
          />
          <TooltipPopup side="top">{title}</TooltipPopup>
        </Tooltip>
        <PopoverPopup align="center" aria-label={title} side="top" width="sm">
          <div className="flex flex-col text-left">
            <div className="text-sm leading-5 font-medium">{title}</div>
            <div className="mt-0.5 text-xs leading-4 text-muted-foreground">
              {release.releaseCount > 1
                ? `${release.releaseCount} releases ahead of this build (v${release.currentVersion}).`
                : `This build is v${release.currentVersion}.`}{" "}
              Ask FirstMate to sync the fork.
            </div>
            <div className="mt-3 flex items-center gap-2">
              {releaseUrl ? (
                <Button
                  onClick={() =>
                    void openDesktopUpdateReleaseNotes(window.desktopBridge, releaseUrl)
                  }
                  size="xs"
                  variant="outline"
                >
                  Release notes
                  <ExternalLinkIcon aria-hidden />
                </Button>
              ) : null}
              <Button onClick={dismiss} size="xs" variant="ghost">
                Dismiss
              </Button>
            </div>
          </div>
        </PopoverPopup>
      </Popover>
    </SidebarMenuItem>
  );
}
