const LEADING_FRONTMATTER =
  /^\uFEFF?---[ \t]*(?:\r\n|\r|\n)(?:[\s\S]*?(?:\r\n|\r|\n))?(?:---|\.\.\.)[ \t]*(?=\r\n|\r|\n|$)/;

const BLANK_LINE = /(?:\r\n|\r|\n)[ \t]*(?:\r\n|\r|\n)/;
const KEY_LINE = /(?:^|\r\n|\r|\n)[^\s:#-][^:\r\n]*:(?:[ \t]|\r|\n|$)/;

/**
 * Length of the leading YAML frontmatter block, or 0 when the document has none.
 * Two rules around paragraphs, with a blank line and no `key:` line between
 * them, are Markdown rather than frontmatter.
 */
export function markdownFrontmatterLength(markdown: string): number {
  const block = LEADING_FRONTMATTER.exec(markdown)?.[0];
  if (block === undefined) return 0;
  return BLANK_LINE.test(block) && !KEY_LINE.test(block) ? 0 : block.length;
}

/**
 * Blanks a leading YAML frontmatter block so rendered previews skip it instead
 * of showing a rule and a setext heading. Masked characters become spaces and
 * line breaks stay, so source offsets (task checkbox edits) stay valid.
 */
export function maskMarkdownFrontmatter(markdown: string): string {
  const length = markdownFrontmatterLength(markdown);
  return markdown.slice(0, length).replace(/[^\r\n]/g, " ") + markdown.slice(length);
}
