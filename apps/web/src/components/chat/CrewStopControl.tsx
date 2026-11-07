import { SquareIcon } from "lucide-react";

import { Button } from "../ui/button";

/** All that stays of the composer in a FirstMate worker, and only while it runs. */
export function CrewStopControl({ onStop }: { readonly onStop: () => void }) {
  return (
    <div className="flex justify-end px-1">
      <Button size="xs" variant="outline" onClick={onStop}>
        <SquareIcon className="size-3 fill-current" />
        Stop
      </Button>
    </div>
  );
}
