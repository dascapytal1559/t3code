import {
  AuthFilesystemReadScope,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { WORKSPACE_BASENAME_LOOKUP_LIMIT } from "@t3tools/client-runtime/workspace-basename-lookup";
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
import { projectEnvironment } from "~/state/projects";
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
import {
  findImageEmbed,
  imageAssetResource,
  imageEmbedFileKey,
  imageEmbedSourceOf,
  imageEmbedTargetOf,
  imageSourceOf,
  linkUrlOf,
} from "./liveMarkdownHost";
import { MarkdownOutlineColumn } from "./MarkdownOutlineColumn";
import type { MarkdownOutlineSource } from "./outline";
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
  /** Offers the editor's outline to the panel's outline button, and takes it back on unmount. */
  readonly onOutlineSource: (source: MarkdownOutlineSource | null) => void;
  /** Pins the outline in a column beside the page. */
  readonly showOutline: boolean;
}

function decodeAnchor(anchor: string): string {
  try {
    return decodeURIComponent(anchor);
  } catch {
    return anchor;
  }
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
  onOutlineSource,
  showOutline,
}: LiveMarkdownSurfaceProps) {
  const saveTarget = { environmentId, cwd, relativePath, threadId: hostFileThreadId };
  useFileSaveSession(saveTarget, onPendingChange);
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<LiveMarkdownEditor | null>(null);
  // The pinned outline reads the editor, which exists only once mounted.
  const [mountedEditor, setMountedEditor] = useState<LiveMarkdownEditor | null>(null);
  // An edit can land between a render and its effects. Every edit is written to the
  // optimistic file at once, so that is read ahead of a prop that may be a render behind.
  const latestContents = useEffectEvent(
    () => getOptimisticProjectFileQueryData(environmentId, cwd, relativePath)?.contents ?? contents,
  );
  // The editor's own last edit comes back as `contents`. It is the same string, so
  // telling it apart costs nothing, where diffing the whole file on every key would.
  const lastEdit = useRef<string | null>(null);
  const saveEdit = useEffectEvent((text: string) => {
    if (text === latestContents()) return;
    lastEdit.current = text;
    setProjectFileQueryData(environmentId, cwd, relativePath, text);
    changeFileSaveSession(saveTarget, text);
  });

  // Paths written in the file are read from the file's own folder first.
  const lastSeparator = Math.max(relativePath.lastIndexOf("/"), relativePath.lastIndexOf("\\"));
  const baseDir =
    lastSeparator >= 0 ? resolvePathLinkTarget(relativePath.slice(0, lastSeparator), cwd) : cwd;

  // The editor names the images that come into view; the server signs a URL for each.
  const [imageKeys, setImageKeys] = useState<readonly string[]>([]);
  const addImageKey = (key: string) =>
    setImageKeys((keys) => (keys.includes(key) ? keys : [...keys, key]));
  // Each picture embed found, by its key, to the key of the file it embeds.
  const [embedFiles, setEmbedFiles] = useState<ReadonlyMap<string, string>>(new Map());
  const signedUrls = useAssetUrls(
    environmentId,
    imageKeys.map((key) => imageAssetResource(key, threadRef.threadId)),
  );
  // A new workspace revision refetches the pictures, as the image preview does.
  const revision =
    workspaceMutationId === null
      ? ""
      : `workspace-revision=${encodeURIComponent(workspaceMutationId)}`;
  const fileUrls = new Map(
    imageKeys.flatMap((key, index) => {
      const url = signedUrls[index];
      if (!url) return [];
      return [[key, revision ? `${url}${url.includes("?") ? "&" : "?"}${revision}` : url] as const];
    }),
  );
  const imageUrls = [
    ...fileUrls,
    ...[...embedFiles].flatMap(([embed, file]) => {
      const url = fileUrls.get(file);
      return url ? [[embed, url] as const] : [];
    }),
  ];
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
      if (destination.startsWith("#")) {
        // A link to a heading of this file.
        editorRef.current?.jumpToAnchor(decodeAnchor(destination.slice(1)));
        return;
      }
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
  const searchEntries = useAtomQueryRunner(projectEnvironment.searchEntries, {
    reportFailure: false,
  });
  const embedKeys = useRef(new Set<string>());
  const lookUpEmbed = useEffectEvent((key: string) => {
    const target = imageEmbedTargetOf(key);
    if (target === null) return;
    if (!readEnvironmentScope(environmentId, AuthFilesystemReadScope)) return;
    void findImageEmbed(target, baseDir, cwd, {
      files: async (paths) => {
        const metadata = await getFilesystemMetadata({
          environmentId,
          input: { paths: [...paths] },
        });
        return metadata._tag === "Success"
          ? metadata.value.entries.map((entry) => entry?.kind === "file")
          : null;
      },
      search: async (name) => {
        const result = await searchEntries({
          environmentId,
          input: { cwd, query: name, limit: WORKSPACE_BASENAME_LOOKUP_LIMIT, kind: "file" },
        });
        return result._tag === "Success" ? result.value.entries : [];
      },
    }).then((path) => {
      if (path === null) {
        setEmbedFiles((files) => {
          if (!files.has(key)) return files;
          const next = new Map(files);
          next.delete(key);
          return next;
        });
        return;
      }
      const file = imageEmbedFileKey(path);
      addImageKey(file);
      setEmbedFiles((files) => (files.get(key) === file ? files : new Map(files).set(key, file)));
    });
  });
  const imageNeeded = useEffectEvent((key: string) => {
    if (imageEmbedTargetOf(key) === null) return addImageKey(key);
    embedKeys.current.add(key);
    lookUpEmbed(key);
  });
  const lookedUpAt = useRef(workspaceMutationId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a workspace change can add or move the file an embed names, which only a new lookup finds
  useEffect(() => {
    if (lookedUpAt.current === workspaceMutationId) return;
    lookedUpAt.current = workspaceMutationId;
    for (const key of embedKeys.current) lookUpEmbed(key);
  }, [workspaceMutationId]);
  const offerOutline = useEffectEvent((source: MarkdownOutlineSource | null) =>
    onOutlineSource(source),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts the CodeMirror editor, which lives outside React, on its host element
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const editor = createLiveMarkdownEditor({
      parent: host,
      doc: latestContents(),
      onChange: (text) => saveEdit(text),
      resolveImage: (source) => resolveImage(source),
      resolveImageEmbed: imageEmbedSourceOf,
      onImageNeeded: (key) => imageNeeded(key),
      onOpenLink: (href, event) => followLink(href, event),
    });
    editorRef.current = editor;
    setMountedEditor(editor);
    offerOutline(editor.outline);
    return () => {
      offerOutline(null);
      setMountedEditor(null);
      editorRef.current = null;
      editor.destroy();
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands contents that changed on disk to the editor, which keeps its own document
  useEffect(() => {
    const latest =
      getOptimisticProjectFileQueryData(environmentId, cwd, relativePath)?.contents ?? contents;
    if (latest === lastEdit.current) return;
    // Anything else is the file's word; the editor's last edit no longer describes it.
    lastEdit.current = null;
    editorRef.current?.applyExternal(latest);
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

  return (
    <div className="flex min-h-0 flex-1">
      {showOutline && mountedEditor ? <MarkdownOutlineColumn editor={mountedEditor} /> : null}
      <div ref={hostRef} data-live-markdown className="min-h-0 flex-1" />
    </div>
  );
}
