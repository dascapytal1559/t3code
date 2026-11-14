import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";

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
import "./liveMarkdown.css";
import "./markdownProperties.css";

export interface LiveMarkdownSurfaceProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  /** FirstMate's thread, sent with saves of a host file it may edit. */
  readonly hostFileThreadId: ThreadId | undefined;
  readonly contents: string;
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
  contents,
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts the CodeMirror editor, which lives outside React, on its host element
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const editor = createLiveMarkdownEditor({
      parent: host,
      doc: latestContents(),
      onChange: (text) => saveEdit(text),
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

  return <div ref={hostRef} data-live-markdown className="min-h-0 flex-1" />;
}
