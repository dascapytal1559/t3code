// Match only the diagram declaration, after optional frontmatter and comments.
// A direction inside a subgraph or label belongs to that content and stays intact.
const FLOWCHART_HEADER =
  /^(\s*(?:---\r?\n[\s\S]*?\r?\n---\s*)?(?:(?:%%\{[\s\S]*?\}%%|%%[^\r\n]*(?:\r?\n|$))\s*)*(?:flowchart(?:-elk)?|graph)[ \t]+)(LR|RL|BT)(?=[\s;]|$)/;

export function verticalMermaidSource(code: string): string {
  return code.replace(FLOWCHART_HEADER, "$1TB");
}
