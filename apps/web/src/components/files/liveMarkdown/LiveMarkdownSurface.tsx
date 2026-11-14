import {
  AuthFilesystemReadScope,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { normalizeMarkdownLinkDestination } from "@t3tools/shared/markdownLinks";
import { isHostPath, workspaceRelativeFilePath } from "@t3tools/shared/path";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { useAssetUrls } from "~/assets/assetUrls";
import { useOpenLink } from "~/browser/useOpenLink";
import { resolveMarkdownFileLinkMeta } from "~/markdown-links";
import { pickMarkdownFileCandidate } from "~/markdownFileHostPath";
import { useRightPanelStore } from "~/rightPanelStore";
import { filesystemEnvironment } from "~/state/filesystem";
import { readEnvironmentScope } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import {
  changeFileSaveSession,
  type FilePendingListener,
  useFileSaveSession,
} from "../fileSaveSessions";
import {
  getOptimisticProjectFileQueryData,
  setProjectFileQueryData,
} from "../projectFilesQueryState";
import { createLiveMarkdownEditor, type LiveMarkdownEditor } from "./liveMarkdownEditor";
import { imageAssetResource, imageSourceOf, linkUrlOf } from "./liveMarkdownHost";
import "./liveMarkdown.css";
import "./markdownProperties.css";

export interface LiveMarkdownSurfaceProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  /** FirstMate's thread, sent with saves of a host file it may edit. */
  readonly hostFileThreadId: ThreadId | undefined;
  readonly threadRef: ScopedThreadRef;
  readonly contents: string;
  readonly workspaceMutationId: string | null;
  /** The line a link opened the file at, until the reader has moved on from it. */
  readonly revealLine: number | null;
  readonly revealRequestId: number;
  readonly onPendingChange: FilePendingListener;
}

/**
 * The live Markdown editor for a file that can be edited. It saves through the
 * same session and query data as the source editor, so the two never disagree.
 */
export default function LiveMarkdownSurface({
  environmentId,
  cwd,
  relativePath,
  hostFileThreadId,
  threadRef,
  contents,
  workspaceMutationId,
  revealLine,
  revealRequestId,
  onPendingChange,
}: LiveMarkdownSurfaceProps) {
  const saveTarget = { environmentId, cwd, relativePath, threadId: hostFileThreadId };
  useFileSaveSession(saveTarget, onPendingChange);
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<LiveMarkdownEditor | null>(null);
  // An edit can land between a render and its effects. Every edit is written to the
  // optimistic file at once, so that is read ahead of a prop that may be a render behind.
  const latestContents = useEffectEvent(
    () => getOptimisticProjectFileQueryData(environmentId, cwd, relativePath)?.contents ?? contents,
  );
  const saveEdit = useEffectEvent((text: string) => {
    if (text === latestContents()) return;
    setProjectFileQueryData(environmentId, cwd, relativePath, text);
    changeFileSaveSession(saveTarget, text);
  });

  // Paths written in the file are read from the file's own folder first.
  const lastSeparator = Math.max(relativePath.lastIndexOf("/"), relativePath.lastIndexOf("\\"));
  const baseDir =
    lastSeparator >= 0 ? resolvePathLinkTarget(relativePath.slice(0, lastSeparator), cwd) : cwd;

  // The editor names the images that come into view; the server signs a URL for each.
  const [imageKeys, setImageKeys] = useState<readonly string[]>([]);
  const signedUrls = useAssetUrls(
    environmentId,
    imageKeys.map((key) => imageAssetResource(key, threadRef.threadId)),
  );
  // A new workspace revision refetches the pictures, as the image preview does.
  const revision =
    workspaceMutationId === null
      ? ""
      : `workspace-revision=${encodeURIComponent(workspaceMutationId)}`;
  const imageUrls = imageKeys.flatMap((key, index) => {
    const url = signedUrls[index];
    if (!url) return [];
    return [[key, revision ? `${url}${url.includes("?") ? "&" : "?"}${revision}` : url] as const];
  });
  const imageUrlsKey = imageUrls.map((entry) => entry.join("\n")).join("\n");
  const drawImages = useEffectEvent(() => editorRef.current?.setImageUrls(new Map(imageUrls)));

  const openLink = useOpenLink(threadRef);
  const getFilesystemMetadata = useAtomQueryRunner(filesystemEnvironment.getMetadata, {
    reportFailure: false,
    refresh: true,
  });
  const followLink = useEffectEvent((href: string, event: MouseEvent) => {
    const destination = normalizeMarkdownLinkDestination(href);
    const file = resolveMarkdownFileLinkMeta(destination, cwd, baseDir);
    if (file === null) {
      if (destination.startsWith("#")) return;
      void openLink(linkUrlOf(destination), { event }).catch((cause: unknown) =>
        console.error(cause),
      );
      return;
    }
    const open = (path: string, alsoTried?: string) =>
      useRightPanelStore.getState().openFile(threadRef, path, file.line, alsoTried);
    const written = file.workspaceRelativePath ?? file.filePath;
    if (file.fallbackFilePath === null) {
      if (file.workspaceRelativePath !== null || isHostPath(file.filePath)) open(written);
      return;
    }
    // A bare path may be meant from the workspace root: the file's folder wins when both exist.
    void pickMarkdownFileCandidate(file, async (paths) => {
      if (!readEnvironmentScope(environmentId, AuthFilesystemReadScope)) return null;
      const metadata = await getFilesystemMetadata({ environmentId, input: { paths: [...paths] } });
      return metadata._tag === "Success"
        ? metadata.value.entries.map((entry) => entry !== null)
        : null;
    }).then(({ filePath, alsoTried }) => {
      if (filePath === file.filePath) open(written, alsoTried ?? undefined);
      else open(workspaceRelativeFilePath(filePath, cwd) ?? filePath);
    });
  });
  const resolveImage = useEffectEvent((source: string) => imageSourceOf(source, baseDir));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts the CodeMirror editor, which lives outside React, on its host element
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const editor = createLiveMarkdownEditor({
      parent: host,
      doc: latestContents(),
      onChange: (text) => saveEdit(text),
      resolveImage: (source) => resolveImage(source),
      onImageNeeded: (key) => setImageKeys((keys) => (keys.includes(key) ? keys : [...keys, key])),
      onOpenLink: (href, event) => followLink(href, event),
    });
    editorRef.current = editor;
    return () => {
      editorRef.current = null;
      editor.destroy();
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands contents that changed on disk to the editor, which keeps its own document
  useEffect(() => {
    editorRef.current?.applyExternal(
      getOptimisticProjectFileQueryData(environmentId, cwd, relativePath)?.contents ?? contents,
    );
  }, [contents, cwd, environmentId, relativePath]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands newly signed image URLs to the editor, which draws the images
  useEffect(() => {
    drawImages();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- The key names the URLs, so a new set of them is drawn.
  }, [imageUrlsKey]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the editor to the line a link asked for; each request does so once
  useEffect(() => {
    if (revealLine !== null) editorRef.current?.revealLine(revealLine);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A second link to the same line is a new request for it.
  }, [revealLine, revealRequestId]);

  return <div ref={hostRef} data-live-markdown className="min-h-0 flex-1" />;
}
