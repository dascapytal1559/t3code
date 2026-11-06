import { MessageId, type CommandId, type RunId } from "@t3tools/contracts";

/** The turn that lets FirstMate stow its session before the context is dropped. */
export const SESSION_REFRESH_STOW_TEXT = "/stow";
/** The fresh session's first message; it only starts the session. FirstMate answers `ahoy` with Bearings, so never that. */
export const SESSION_REFRESH_OPENING_TEXT = "Context refreshed.";

const STOW_MESSAGE_PREFIX = "session-refresh:stow:";

export function sessionRefreshStowMessageId(commandId: CommandId): MessageId {
  return MessageId.make(`${STOW_MESSAGE_PREFIX}${commandId}`);
}

/** The `/stow` turn a context refresh started; its end decides whether the session is replaced. */
export function isSessionRefreshStowMessageId(messageId: MessageId): boolean {
  return messageId.startsWith(STOW_MESSAGE_PREFIX);
}

export function sessionRefreshOpeningMessageId(stowRunId: RunId): MessageId {
  return MessageId.make(`session-refresh:opening:${stowRunId}`);
}

export function sessionRefreshKeptNotice(detail: string): string {
  return `Context refresh stopped: ${detail} The agent session was kept.`;
}
