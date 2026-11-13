import type { EnvironmentId, PinnedReport, ScopedThreadRef } from "@t3tools/contracts";
import { PinOffIcon } from "lucide-react";
import { useState } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { BridgeSection } from "./BridgeSection";
import { nightHeading, reportLinkMarkdown, reportsByNight } from "./needsMe.logic";

/**
 * Finished reports FirstMate pinned, by evening: the latest evening first, earlier ones on request.
 * Phone web reads them; unpinning is desktop's.
 */
export function ReportsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly reports: ReadonlyArray<PinnedReport & { readonly id: string }>;
  readonly hostRef: ScopedThreadRef;
  readonly nowMs: number;
}) {
  const isPhone = useMediaQuery("max-sm");
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, "Unpin report");
  const [nightsShown, setNightsShown] = useState(1);
  const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const nights = reportsByNight(props.reports, timeZone);
  const shown = nights.slice(0, nightsShown);
  // Report files are on the reports' environment; a host chat elsewhere cannot open them.
  const threadRef = props.hostRef.environmentId === props.environmentId ? props.hostRef : undefined;

  return (
    <BridgeSection
      id="reports"
      title="Reports"
      count={shown.reduce((total, night) => total + night.reports.length, 0)}
    >
      {shown.map(({ night, reports }) => (
        <section
          key={night}
          aria-labelledby={`reports-night-${night}`}
          className="not-first:mt-3"
        >
          <h3 id={`reports-night-${night}`} className="px-2 pt-1 text-xs text-muted-foreground">
            {nightHeading(night, new Date(props.nowMs), timeZone)}
          </h3>
          <ul className="flex flex-col gap-1">
            {reports.map((report) => (
              <li key={report.id} className="flex items-start gap-2 rounded-lg px-2 py-1.5">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <p className="text-sm font-medium text-foreground">{report.title}</p>
                  <p className="text-xs text-muted-foreground">{report.summary}</p>
                  <ChatMarkdown
                    text={reportLinkMarkdown(report.location)}
                    cwd={undefined}
                    threadRef={threadRef}
                    environmentId={props.environmentId}
                    className="text-xs"
                  />
                </div>
                {isPhone ? null : (
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Unpin ${report.title}`}
                    title="Unpin"
                    onClick={() =>
                      void updateSettings({
                        environmentId: props.environmentId,
                        input: { patch: { pinnedReports: { [report.id]: null } } },
                      })
                    }
                  >
                    <PinOffIcon className="size-3.5" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {nights.length > nightsShown ? (
        <div className="px-1 pt-1">
          <Button size="xs" variant="ghost-muted" onClick={() => setNightsShown(nightsShown + 1)}>
            Show earlier
          </Button>
        </div>
      ) : null}
    </BridgeSection>
  );
}
