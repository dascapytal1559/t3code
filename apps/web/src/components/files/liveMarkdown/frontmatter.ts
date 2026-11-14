export interface FrontmatterRow {
  readonly key: string;
  readonly value: string;
}

const unquote = (value: string) => {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  if (quoted) return quoted[2] ?? "";
  const list = /^\[(.*)\]$/.exec(value);
  return list ? (list[1] ?? "").trim() : value;
};

/**
 * The top-level `key: value` rows of a frontmatter block, fences included in
 * `block`. This reads the block for display only: list items and the lines of a
 * block scalar are joined onto their key, and nested maps keep their text.
 */
export function frontmatterRows(block: string): FrontmatterRow[] {
  const rows: { key: string; value: string; joiner: string }[] = [];
  for (const line of block.split(/\r\n|\r|\n/).slice(1, -1)) {
    const entry = /^([^\s:#-][^:]*):(?:\s+(.*))?$/.exec(line);
    if (entry) {
      const value = (entry[2] ?? "").trim();
      const scalar = /^[|>][+-]?$/.test(value);
      rows.push({
        key: (entry[1] ?? "").trim(),
        value: scalar ? "" : unquote(value),
        joiner: scalar ? " " : ", ",
      });
      continue;
    }
    const last = rows.at(-1);
    const more = line.trim();
    if (last === undefined || more === "" || more.startsWith("#")) continue;
    const item = unquote(more.replace(/^-\s+/, ""));
    last.value = last.value === "" ? item : `${last.value}${last.joiner}${item}`;
  }
  return rows.map(({ key, value }) => ({ key, value }));
}
