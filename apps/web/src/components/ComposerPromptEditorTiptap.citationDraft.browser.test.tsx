import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import { createRef, useState } from "react";
import { expect, it } from "vite-plus/test";

import { page, userEvent } from "vite-plus/test/browser";

import { findAssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { act, render } from "../../test/render";
import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "./ComposerPromptEditorTiptap";

const citation = {
  version: 1 as const,
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("source"),
  text: "hello",
  start: 0,
  end: 5,
  prefix: "",
  suffix: "",
};
const promptBefore = `See ${serializeAssistantCitation(citation)} `;
const promptWithComment = `See ${serializeAssistantCitation(withAssistantCitationComment(citation, "check this"))} `;

function Composer({
  question,
  editorRef,
  disabled = false,
  send = "clears",
  initialPrompt = promptBefore,
}: {
  question: boolean;
  editorRef: React.RefObject<ComposerPromptEditorHandle | null>;
  disabled?: boolean;
  send?: "clears" | "blocked" | "refusedLater";
  initialPrompt?: string;
}) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [answer, setAnswer] = useState("");
  return (
    <>
      <div data-assistant-citation-viewport="">
        <p
          data-assistant-citation-source={citation.messageId}
          data-assistant-citation-environment={citation.environmentId}
          data-assistant-citation-thread={citation.threadId}
        >
          hello world
        </p>
      </div>
      <output data-prompt={prompt} data-answer={answer} />
      <ComposerPromptEditor
        editorRef={editorRef}
        value={question ? answer : prompt}
        cursor={0}
        contextRecords={new Map()}
        skills={[]}
        disabled={disabled}
        placeholder=""
        onChange={(next) => (question ? setAnswer(next) : setPrompt(next))}
        onCitationDraftSave={(replacedValue, savedValue) => {
          if (replacedValue === prompt) setPrompt(savedValue);
        }}
        onCitationSubmitAndSend={() => {
          if (send === "blocked") return false;
          if (send === "clears") setPrompt("");
          return true;
        }}
        onPaste={() => {}}
      />
    </>
  );
}

it("keeps an unsaved citation comment when a question takes the composer", async () => {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  await using screen = await render(<Composer question={false} editorRef={editorRef} />);
  const drafts = () => screen.container.querySelector("output")?.dataset;

  const sourceAnchor = findAssistantCitationSourceAnchor(document, citation);
  if (!sourceAnchor) throw new Error("Citation source did not resolve");
  await act(async () =>
    editorRef.current?.requestCitationComment({
      previousValue: "See ",
      value: promptBefore,
      citationStart: "See ".length,
      sourceAnchor,
      insertedSpaces: { before: false, after: true },
    }),
  );
  const chip = () => screen.container.querySelector("[data-assistant-citation-chip]");
  const comment = page.getByLabelText("Comment on selected text");
  await expect.element(comment).toBeVisible();
  expect(chip()?.getAttribute("data-comment")).toBe("empty");
  await expect
    .element(page.getByRole("button", { name: "Delete citation" }))
    .not.toBeInTheDocument();
  await comment.click();
  await userEvent.keyboard("check this");

  await screen.rerender(<Composer question editorRef={editorRef} />);
  expect(drafts()?.answer).toBe("");
  await screen.rerender(<Composer question={false} editorRef={editorRef} />);

  expect(drafts()?.prompt).toBe(promptWithComment);
  await expect.element(page.getByLabelText("Edit citation comment")).toBeInTheDocument();
  expect(chip()?.getAttribute("data-comment")).toBe("present");
  await expect
    .element(page.getByRole("button", { name: "Remove citation" }))
    .not.toBeInTheDocument();
});

it("deletes a commented citation from its comment editor, and undo brings it back", async () => {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  await using screen = await render(
    <Composer question={false} editorRef={editorRef} initialPrompt={promptWithComment} />,
  );
  const prompt = () => screen.container.querySelector("output")?.dataset.prompt;

  // With no cross on the chip, Shift+Tab from the caret after it lands on the pencil.
  await act(async () => editorRef.current?.focusAt("See ".length + 1));
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  await expect.element(page.getByLabelText("Edit citation comment")).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await page.getByRole("button", { name: "Delete citation" }).click();

  expect(prompt()).toBe("See ");
  await expect.element(page.getByLabelText("Comment on selected text")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("composer-editor")).toHaveFocus();
  await userEvent.keyboard("{ControlOrMeta>}z{/ControlOrMeta}");
  expect(prompt()).toBe(promptWithComment);
  await expect.element(page.getByLabelText("Comment on selected text")).not.toBeInTheDocument();
});

it("removes a citation and its space with the chip's cross, and undo brings it back", async () => {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  await using screen = await render(<Composer question={false} editorRef={editorRef} />);
  const prompt = () => screen.container.querySelector("output")?.dataset.prompt;

  await page.getByRole("button", { name: "Remove citation" }).click();

  expect(prompt()).toBe("See ");
  await expect.element(page.getByLabelText("Add comment to citation")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("composer-editor")).toHaveFocus();
  await userEvent.keyboard("{ControlOrMeta>}z{/ControlOrMeta}");
  expect(prompt()).toBe(promptBefore);
});

it("reaches the citation's cross from the caret after it with Shift+Tab", async () => {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  await using screen = await render(<Composer question={false} editorRef={editorRef} />);

  // Cursors count a chip as one character.
  await act(async () => editorRef.current?.focusAt("See ".length + 1));
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  await expect.element(page.getByRole("button", { name: "Remove citation" })).toHaveFocus();
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  await expect.element(page.getByLabelText("Add comment to citation")).toHaveFocus();
  await userEvent.keyboard("{Tab}{Enter}");

  expect(screen.container.querySelector("output")?.dataset.prompt).toBe("See ");
});

it("clears the sent prompt when an empty citation comment sends it", async () => {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  await using screen = await render(<Composer question={false} editorRef={editorRef} />);

  const sourceAnchor = findAssistantCitationSourceAnchor(document, citation);
  if (!sourceAnchor) throw new Error("Citation source did not resolve");
  await act(async () =>
    editorRef.current?.requestCitationComment({
      previousValue: "See ",
      value: promptBefore,
      citationStart: "See ".length,
      sourceAnchor,
      insertedSpaces: { before: false, after: true },
    }),
  );
  const comment = page.getByLabelText("Comment on selected text");
  await expect.element(comment).toHaveFocus();
  await userEvent.keyboard("{Control>}{Enter}{/Control}");

  await expect.element(comment).not.toBeInTheDocument();
  await expect.element(page.getByTestId("composer-editor")).toHaveFocus();
  await expect.element(screen.getByRole("status")).toHaveAttribute("data-prompt", "");
});

it.each(["blocked", "refusedLater"] as const)(
  "keeps the caret after the citation when save-and-send is %s",
  async (send) => {
    const editorRef = createRef<ComposerPromptEditorHandle>();
    await using screen = await render(
      <Composer question={false} editorRef={editorRef} send={send} />,
    );

    const sourceAnchor = findAssistantCitationSourceAnchor(document, citation);
    if (!sourceAnchor) throw new Error("Citation source did not resolve");
    await act(async () =>
      editorRef.current?.requestCitationComment({
        previousValue: "See ",
        value: promptBefore,
        citationStart: "See ".length,
        sourceAnchor,
        insertedSpaces: { before: false, after: true },
      }),
    );
    const comment = page.getByLabelText("Comment on selected text");
    await expect.element(comment).toHaveFocus();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await expect.element(comment).not.toBeInTheDocument();
    await userEvent.keyboard("x");

    await expect
      .element(screen.getByRole("status"))
      .toHaveAttribute("data-prompt", `See ${serializeAssistantCitation(citation)}x `);
  },
);

it("cancels a new citation while dictation makes the composer read-only", async () => {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  await using screen = await render(<Composer question={false} editorRef={editorRef} disabled />);

  const sourceAnchor = findAssistantCitationSourceAnchor(document, citation);
  if (!sourceAnchor) throw new Error("Citation source did not resolve");
  await act(async () =>
    editorRef.current?.requestCitationComment({
      previousValue: "See ",
      value: promptBefore,
      citationStart: "See ".length,
      sourceAnchor,
      insertedSpaces: { before: false, after: true },
    }),
  );
  await expect.element(page.getByLabelText("Comment on selected text")).toBeVisible();

  await page.getByRole("button", { name: "Cancel" }).click();

  await expect.element(page.getByLabelText("Comment on selected text")).not.toBeInTheDocument();
  expect(screen.container.querySelector("output")?.dataset.prompt).toBe("See ");
});
