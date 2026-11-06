import { CommandId, type ThreadDecisionAttachment } from "@t3tools/contracts";

import { randomUUID } from "../../lib/utils";

const PICTURE_PATH = /\.(?:png|jpe?g|gif|webp|avif|svg)$/i;

const escapeLabel = (label: string) => label.replace(/[[\]\\]/g, "\\$&");

/**
 * A decision's attachments as Markdown, so the chat's own renderer draws pictures and opens
 * reports and links the way it does in a message. Paths resolve against the project folder.
 */
export function decisionAttachmentsMarkdown(
  attachments: ReadonlyArray<ThreadDecisionAttachment>,
): string | null {
  if (attachments.length === 0) return null;
  const pictures: string[] = [];
  const links: string[] = [];
  for (const attachment of attachments) {
    const label = escapeLabel(
      attachment.label ?? attachment.path.split("/").at(-1) ?? attachment.kind,
    );
    const target = `<${attachment.path.replace(/[<>]/g, encodeURIComponent)}>`;
    if (PICTURE_PATH.test(attachment.path)) pictures.push(`![${label}](${target})`);
    else links.push(`- [${label}](${target})`);
  }
  return [...pictures, ...(links.length === 0 ? [] : [links.join("\n")])].join("\n\n");
}

export function decisionReplyCommandId(): CommandId {
  return CommandId.make(`web:decision-reply:${randomUUID()}`);
}
