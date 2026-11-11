import type { EnvironmentId, PinnedReport, ScopedThreadRef } from "@t3tools/contracts";
import { PinOffIcon } from "lucide-react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { BridgeSection } from "./BridgeSection";
import { formatDay, reportLinkMarkdown } from "./needsMe.logic";

/** Finished reports FirstMate pinned, newest first. Phone web reads them; unpinning is desktop's. */
export function ReportsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly reports: ReadonlyArray<PinnedReport & { readonly id: string }>;
  readonly hostRef: ScopedThreadRef;
}) {
  const isPhone = useMediaQuery("max-sm");
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, "Unpin report");
  // Report files are on the reports' environment; a host chat elsewhere cannot open them.
  const threadRef = props.hostRef.environmentId === props.environmentId ? props.hostRef : undefined;

  return (
    <BridgeSection id="reports" title="Reports" count={props.reports.length}>
      <ul className="flex flex-col gap-1">
        {props.reports.map((report) => (
          <li key={report.id} className="flex items-start gap-2 rounded-lg px-2 py-1.5">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="flex items-baseline gap-2 text-sm">
                <span className="min-w-0 flex-1 font-medium text-foreground">{report.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {formatDay(report.pinnedAt)}
                </span>
              </p>
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
    </BridgeSection>
  );
}
