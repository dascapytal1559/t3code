import { markdownFrontmatterLength } from "@t3tools/shared/markdownFrontmatter";

import { frontmatterRows } from "./frontmatter";
import "./markdownProperties.css";

/** A file's frontmatter, which the rendered view otherwise hides. */
export function MarkdownPropertiesCard(props: {
  readonly text: string;
  readonly className?: string;
}) {
  const rows = frontmatterRows(props.text.slice(0, markdownFrontmatterLength(props.text)));
  if (rows.length === 0) return null;
  return (
    <div className={props.className}>
      <div data-markdown-properties>
        <div data-head>Properties</div>
        {rows.map((row, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- a key can repeat in frontmatter; rows follow the block's order
          <div key={`${index}:${row.key}`} className="contents">
            <span data-key>{row.key}</span>
            <span data-value>{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
