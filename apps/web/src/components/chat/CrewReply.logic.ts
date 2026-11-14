import type { ThreadId } from "@t3tools/contracts";

/**
 * The message a reply from a worker's thread puts in its coordinator's chat: a header naming the
 * worker, the line FirstMate reads the worker from (`bin/fm-t3-worker-reply.sh`), then the words.
 */
export function formatCrewReply(input: {
  readonly thread: { readonly id: ThreadId; readonly title: string };
  readonly text: string;
}): string {
  return [
    `**Reply · ${input.thread.title}**`,
    `kept-thread: ${input.thread.id}`,
    "",
    input.text.trim(),
  ].join("\n");
}
