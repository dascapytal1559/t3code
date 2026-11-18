import type { EditorView } from "@codemirror/view";
import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  type ContextMenuItem,
  type EnvironmentId,
} from "@t3tools/contracts";
import { msg } from "gt-react";
import { use, useEffect, useEffectEvent } from "react";

import { contextMenuSourceOf } from "~/contextMenuSource";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { m } from "~/i18n/messages";
import { readLocalApi } from "~/localApi";

import { AssistantSelectionToolbar, type CitationCapture } from "../chat/AssistantSelectionToolbar";
import { CiteInComposerContext } from "./citeInComposerContext";
import {
  buildFileCitation,
  editorSelectionLines,
  renderedSelectionLines,
  splitSourceLines,
  type LineRange,
  type RenderedSelectionEnd,
} from "./fileCitation";

interface CitedFile {
  readonly environmentId: EnvironmentId;
  /** The file's full path, as the agent reads it. */
  readonly path: string;
}

function usableRange(selection: Selection | null, root: Node): Range | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0).cloneRange();
  return root.contains(range.startContainer) && root.contains(range.endContainer) ? range : null;
}

/** A selection in the live editor, cited by the editor's own lines and text. */
export function captureEditorFileSelection(view: EditorView, file: CitedFile): CitationCapture {
  return (_viewport, selection) => {
    const range = usableRange(selection, view.contentDOM);
    const { from, to } = view.state.selection.main;
    if (!range || from === to) return null;
    const citation = buildFileCitation({
      ...file,
      lines: editorSelectionLines(view.state.doc, from, to),
      text: view.state.sliceDoc(from, to),
    });
    return citation ? { citation, source: view.contentDOM, range } : null;
  };
}

const SOURCE_LINES_SELECTOR = "[data-source-lines]";
// Code block headers and copy buttons are drawn around the text, not written in the file.
const CHROME_SELECTOR = "button, [aria-hidden='true'], [data-thread-find-ignore]";

function parseLineRange(value: string | undefined): LineRange | null {
  const match = /^(\d+)-(\d+)$/.exec(value ?? "");
  return match ? { startLine: Number(match[1]), endLine: Number(match[2]) } : null;
}

/** The block's text without its chrome, and how much of it comes before the boundary. */
function textBefore(block: Element, node: Node, offset: number) {
  const before = block.ownerDocument.createRange();
  before.selectNodeContents(block);
  before.setEnd(node, offset);
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let text = "";
  let length: number | null = null;
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (current.parentElement?.closest(CHROME_SELECTOR)) continue;
    const data = (current as Text).data;
    if (length === null) {
      if (current === node) length = text.length + offset;
      else if (!before.intersectsNode(current)) length = text.length;
    }
    text += data;
  }
  return { text, offset: length ?? text.length };
}

function selectionEnd(
  root: HTMLElement,
  node: Node,
  offset: number,
  lineCount: number,
): RenderedSelectionEnd {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const marked = element?.closest<HTMLElement>(SOURCE_LINES_SELECTOR);
  const lines = marked && root.contains(marked) ? parseLineRange(marked.dataset.sourceLines) : null;
  if (marked && lines) return { block: lines, ...textBefore(marked, node, offset) };
  // A block drawn by its own renderer (a code block, a table) loses its mark; it holds the lines
  // between the marked blocks around it.
  let previousEnd = 0;
  let nextStart = lineCount + 1;
  for (const candidate of root.querySelectorAll<HTMLElement>(SOURCE_LINES_SELECTOR)) {
    const range = parseLineRange(candidate.dataset.sourceLines);
    if (!range) continue;
    const position = candidate.compareDocumentPosition(node);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
      previousEnd = Math.max(previousEnd, range.endLine);
    } else if (position & Node.DOCUMENT_POSITION_PRECEDING) {
      nextStart = range.startLine;
      break;
    }
  }
  const block =
    previousEnd < nextStart - 1
      ? { startLine: previousEnd + 1, endLine: nextStart - 1 }
      : { startLine: Math.max(1, previousEnd), endLine: Math.min(lineCount, nextStart) };
  // The unmarked block is the largest element around the end that holds no marked block.
  let unmarked = element ?? root;
  while (
    unmarked !== root &&
    unmarked.parentElement &&
    unmarked.parentElement !== root &&
    !unmarked.parentElement.querySelector(SOURCE_LINES_SELECTOR)
  ) {
    unmarked = unmarked.parentElement;
  }
  return { block, ...textBefore(unmarked, node, offset) };
}

/** A selection in the rendered view, mapped back to the file's source lines. */
export function captureRenderedFileSelection(file: CitedFile, source: string): CitationCapture {
  let lines: string[] | null = null;
  return (viewport, selection) => {
    const root = viewport.querySelector<HTMLElement>("[data-file-citation-source]");
    const range = root ? usableRange(selection, root) : null;
    if (!root || !range || !selection) return null;
    lines ??= splitSourceLines(source);
    const citation = buildFileCitation({
      ...file,
      lines: renderedSelectionLines(
        lines,
        selectionEnd(root, range.startContainer, range.startOffset, lines.length),
        selectionEnd(root, range.endContainer, range.endOffset, lines.length),
      ),
      text: selection.toString().trim(),
    });
    return citation ? { citation, source: root, range } : null;
  };
}

function rangeContainsPoint(range: Range, x: number, y: number): boolean {
  return Array.from(range.getClientRects()).some(
    (rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom,
  );
}

type FileSelectionAction = "cite" | "cut" | "copy";

/**
 * Cite for a selection in a Markdown file: the thread's floating Cite button, and a Cite item in
 * the menu a right-click on the selection opens.
 */
export function FileSelectionCite({
  viewport,
  capture,
  editable = false,
}: {
  viewport: HTMLElement | null;
  capture: CitationCapture;
  /** An editor keeps Tab for itself and offers Cut beside Copy. */
  editable?: boolean;
}) {
  const cite = use(CiteInComposerContext);
  const captureSelection = useEffectEvent((root: HTMLElement, selection: Selection | null) =>
    capture(root, selection),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for right-clicks on the file view's DOM to offer Cite in the context menu
  useEffect(() => {
    if (!viewport || !cite) return;
    const onContextMenu = (event: MouseEvent) => {
      const selection = window.getSelection();
      const captured = captureSelection(viewport, selection);
      if (!captured) return;
      const source = contextMenuSourceOf(event);
      if (source === "mouse" && !rangeContainsPoint(captured.range, event.clientX, event.clientY)) {
        return;
      }
      const api = readLocalApi();
      if (!api) return;
      event.preventDefault();
      const rects = captured.range.getClientRects();
      const last = rects.item(rects.length - 1) ?? captured.range.getBoundingClientRect();
      const tooLong = captured.citation.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH;
      const copied = selection?.toString() ?? "";
      const items: ContextMenuItem<FileSelectionAction>[] = [
        {
          id: "cite",
          label: tooLong
            ? m(msg("Shorten selection to cite"))
            : m(msg("Cite", { $context: "verb, quote the selection in the composer" })),
          disabled: tooLong,
        },
        ...(editable
          ? [
              {
                id: "cut" as const,
                label: m(msg("Cut", { $context: "verb" })),
                separatorBefore: true,
              },
            ]
          : []),
        { id: "copy", label: m(msg("Copy", { $context: "verb" })), separatorBefore: !editable },
      ];
      const position =
        source === "mouse"
          ? { x: event.clientX, y: event.clientY }
          : { x: last.right, y: last.bottom };
      void api.contextMenu.show(items, position, source).then((choice) => {
        if (choice === "cite") {
          const anchor = { source: captured.source, range: captured.range, viewport };
          if (cite(captured.citation, anchor)) window.getSelection()?.removeAllRanges();
        } else if (choice === "cut") {
          document.execCommand("cut");
        } else if (choice === "copy" && !document.execCommand("copy")) {
          void writeTextToClipboard(copied);
        }
      });
    };
    viewport.addEventListener("contextmenu", onContextMenu);
    return () => viewport.removeEventListener("contextmenu", onContextMenu);
  }, [cite, editable, viewport]);

  if (!cite) return null;
  return (
    <AssistantSelectionToolbar
      viewport={viewport}
      capture={capture}
      onCite={cite}
      tabFocusesCite={!editable}
    />
  );
}
