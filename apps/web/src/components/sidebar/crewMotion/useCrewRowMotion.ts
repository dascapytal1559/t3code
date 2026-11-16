import { toServerClock } from "@t3tools/client-runtime/clock";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useLayoutEffect, useRef } from "react";

import { getClientSettings } from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadShells } from "~/state/threads";

import { playCrewEnter, playCrewExit } from "./crewMotion";

// The motion is decoration: a browser that lacks a piece of it shows the list without it.
function decorate(play: () => void) {
  try {
    play();
  } catch (error) {
    console.warn("Crew motion did not play.", error);
  }
}

/**
 * Plays a crewmate row's entrance when it joins the crew line and its exit when its thread ends.
 * Returns the ref for the row's guide line, which is on the page exactly while the row is on the
 * line.
 */
export function useCrewRowMotion(
  thread: { environmentId: EnvironmentId; id: ThreadId; createdAt: string },
  onLine: boolean,
) {
  const lineRef = useRef<HTMLDivElement>(null);
  const { environmentId, id: threadId, createdAt } = thread;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- one-shot DOM motion as the row joins the crew line, and again when its thread ends
  useLayoutEffect(() => {
    const row = onLine ? lineRef.current?.closest("li") : null;
    if (!row) return;
    const threadRef = scopeThreadRef(environmentId, threadId);
    const options = () => ({ traceLight: getClientSettings().crewTraceLightEnabled });
    decorate(() =>
      playCrewEnter(
        row,
        {
          key: scopedThreadKey(threadRef),
          // The server stamped the thread; its clock says how new it is.
          ageMs: toServerClock(environmentId, Date.now()) - Date.parse(createdAt),
        },
        options(),
      ),
    );
    return () => {
      // An archived or deleted thread has left the crew. A row that only moved elsewhere in the
      // sidebar is the list motion's to animate.
      const shell = appAtomRegistry.get(environmentThreadShells.threadShellAtom(threadRef));
      if (shell === null || shell.archivedAt !== null) {
        decorate(() => playCrewExit(row, options()));
      }
    };
  }, [onLine, environmentId, threadId, createdAt]);
  return lineRef;
}
