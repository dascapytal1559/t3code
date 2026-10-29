import {
  linkOriginIsFenced,
  OrchestratorMcpFailure,
  type OrchestrationV2LinkOrigin,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { Caller } from "./threadAccess.ts";

/**
 * Work any signed-in client starts carries its session in `linkOrigin`. Below full access, a peer
 * link's work may change only that link's work: not the user's threads, projects or settings, nor
 * this environment's links. Reads, ordinary clients and full-access links are not fenced.
 */

/** The client a caller acts for: its own session, or the client that started its thread. */
export const callerLinkOrigin = (
  caller: Pick<Caller, "scope" | "caller">,
): OrchestrationV2LinkOrigin | undefined => {
  if (caller.caller?.linkOrigin !== undefined) return caller.caller.linkOrigin;
  const client = caller.scope.client;
  if (client === undefined) return undefined;
  return {
    sessionId: client.sessionId,
    label: client.label,
    access: client.access,
    ...(client.linked === true ? {} : { linked: false }),
  };
};

/** The link that fences a caller, if any: one paired below full access. */
const fencingLinkOrigin = (caller: Pick<Caller, "scope" | "caller">) => {
  const origin = callerLinkOrigin(caller);
  return origin !== undefined && linkOriginIsFenced(origin) ? origin : undefined;
};

const outsideLink = (origin: OrchestrationV2LinkOrigin, message: string) =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: `This work was started from ${origin.label} through a linked environment, so ${message} A link paired with full access is not limited this way.`,
  });

/** A thread a fenced caller may change: one its own link started. */
export const assertSameLink = (
  caller: Pick<Caller, "scope" | "caller">,
  target: Pick<OrchestrationV2ThreadShell, "id" | "linkOrigin">,
) => {
  const origin = fencingLinkOrigin(caller);
  return origin === undefined || target.linkOrigin?.sessionId === origin.sessionId
    ? Effect.void
    : Effect.fail(outsideLink(origin, `it may change only threads that link started.`));
};

/** Fenced work never changes what the environment already has: projects, settings, scheduled runs. */
export const assertNotLinked = (caller: Pick<Caller, "scope" | "caller">, what: string) => {
  const origin = fencingLinkOrigin(caller);
  return origin === undefined
    ? Effect.void
    : Effect.fail(outsideLink(origin, `it cannot ${what}.`));
};
