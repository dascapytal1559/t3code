import { PlayIcon, SquareIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

/**
 * All that stays of the composer in a FirstMate worker: Stop while it runs, and Resume whenever
 * the composer's Resume would show, so a stopped worker can still be brought back.
 */
export function CrewRunControls(props: {
  readonly onStop: (() => void) | null;
  readonly onResume: (() => void) | null;
  readonly isResuming: boolean;
}) {
  if (props.onStop === null && props.onResume === null) return null;
  return (
    <div className="flex justify-end gap-1.5 px-1">
      {props.onResume === null ? null : (
        <Button size="xs" variant="outline" disabled={props.isResuming} onClick={props.onResume}>
          {props.isResuming ? (
            <Spinner size="sm" aria-hidden="true" />
          ) : (
            <PlayIcon className="size-3 fill-current" aria-hidden="true" />
          )}
          Resume
        </Button>
      )}
      {props.onStop === null ? null : (
        <Button size="xs" variant="outline" onClick={props.onStop}>
          <SquareIcon className="size-3 fill-current" />
          Stop
        </Button>
      )}
    </div>
  );
}
