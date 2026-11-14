export interface OutlineItem {
  readonly level: number;
  readonly text: string;
}

/** A Markdown surface's headings, for the panel's outline button. */
export interface MarkdownOutlineSource {
  /** The headings from top to bottom, read each time the list opens. */
  readonly headings: () => readonly OutlineItem[];
  /** Scrolls to the heading at that place in the list. */
  readonly jump: (index: number) => void;
}

/** The anchor GitHub gives each heading, which `#links` in a file point at. A repeat gets `-1`, `-2`. */
export function headingAnchors(headings: readonly OutlineItem[]): string[] {
  const seen = new Map<string, number>();
  return headings.map(({ text }) => {
    const anchor = text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const repeats = seen.get(anchor) ?? 0;
    seen.set(anchor, repeats + 1);
    return repeats === 0 ? anchor : `${anchor}-${repeats}`;
  });
}

// scrollIntoView would also move the overflow-hidden layout around the panel.
function scrollToTopOf(element: HTMLElement) {
  for (let scroller = element.parentElement; scroller; scroller = scroller.parentElement) {
    const overflow = getComputedStyle(scroller).overflowY;
    if (overflow !== "auto" && overflow !== "scroll") continue;
    if (scroller.scrollHeight <= scroller.clientHeight) continue;
    const offset = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop += offset - 12;
    return;
  }
}

/** The outline of the read-only rendered view, read from the headings it drew under `root`. */
export function renderedOutline(root: HTMLElement | null): MarkdownOutlineSource {
  const drawn = () =>
    root
      ? [...root.querySelectorAll<HTMLElement>(".chat-markdown :is(h1, h2, h3, h4, h5, h6)")]
      : [];
  return {
    headings: () =>
      drawn().map((heading) => ({
        level: Number(heading.tagName.slice(1)),
        text: heading.textContent?.trim() ?? "",
      })),
    jump(index) {
      const heading = drawn()[index];
      if (heading) scrollToTopOf(heading);
    },
  };
}
