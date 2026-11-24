import type { ScopedThreadRef } from "@t3tools/contracts";

import ChatMarkdown from "~/components/ChatMarkdown";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { maskMarkdownFrontmatter } from "@t3tools/shared/markdownFrontmatter";

import { MarkdownPropertiesCard } from "./liveMarkdown/MarkdownPropertiesCard";

export function FileMarkdownPreview(props: {
  readonly cwd: string;
  readonly relativePath: string;
  readonly text: string;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceMutationId: string | null;
  readonly className?: string;
  /** Fork: off for the pieces of a very large file, whose lines are not the file's. */
  readonly citable?: boolean;
  readonly onTaskListChange?:
    | ((input: { readonly markerOffset: number; readonly checked: boolean }) => void)
    | undefined;
}) {
  const lastSeparator = Math.max(
    props.relativePath.lastIndexOf("/"),
    props.relativePath.lastIndexOf("\\"),
  );
  const imageBaseDir =
    lastSeparator >= 0
      ? resolvePathLinkTarget(props.relativePath.slice(0, lastSeparator + 1), props.cwd)
      : props.cwd;

  return (
    <>
      {/* Fork: the frontmatter the renderer masks is shown as a card. */}
      <MarkdownPropertiesCard text={props.text} className="mx-auto max-w-4xl px-6 pt-5" />
      {/* Fork: blocks carry their source lines so a selection can be cited. */}
      <div data-file-citation-source="">
        <ChatMarkdown
          text={maskMarkdownFrontmatter(props.text)}
          cwd={props.cwd}
          imageBaseDir={imageBaseDir}
          threadRef={props.threadRef}
          workspaceMutationId={props.workspaceMutationId}
          className={props.className ?? "mx-auto max-w-4xl px-6 py-5"}
          onTaskListChange={props.onTaskListChange}
          sourceLines={props.citable !== false}
        />
      </div>
    </>
  );
}
