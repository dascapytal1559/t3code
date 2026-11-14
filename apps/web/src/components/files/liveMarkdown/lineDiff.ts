export interface TextChange {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

/** Past this many differing lines the middle of the file is replaced as one change. */
const MAX_EDIT_DISTANCE = 600;

interface Lines {
  readonly text: string[];
  /** Offset of each line's first character, plus one past the end as if a break followed. */
  readonly start: number[];
}

function splitLines(text: string): Lines {
  const lines = text.split("\n");
  const start: number[] = [];
  let offset = 0;
  for (const line of lines) {
    start.push(offset);
    offset += line.length + 1;
  }
  start.push(offset);
  return { text: lines, start };
}

/** Myers' shortest edit script over line ids. Null when the two differ by more than the limit. */
function differingLines(
  a: Int32Array,
  b: Int32Array,
): { removed: Uint8Array; added: Uint8Array } | null {
  const max = Math.min(a.length + b.length, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const reach = new Int32Array(2 * max + 3);
  const history: Int32Array[] = [];
  const at = (row: Int32Array, diagonal: number) => row[diagonal + offset] ?? 0;
  const stepsDown = (row: Int32Array, diagonal: number, distance: number) =>
    diagonal === -distance ||
    (diagonal !== distance && at(row, diagonal - 1) < at(row, diagonal + 1));

  for (let distance = 0; distance <= max; distance += 1) {
    history.push(reach.slice());
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      let x = stepsDown(reach, diagonal, distance)
        ? at(reach, diagonal + 1)
        : at(reach, diagonal - 1) + 1;
      let y = x - diagonal;
      while (x < a.length && y < b.length && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      reach[diagonal + offset] = x;
      if (x < a.length || y < b.length) continue;

      const removed = new Uint8Array(a.length);
      const added = new Uint8Array(b.length);
      for (let step = distance; step > 0; step -= 1) {
        const before = history[step];
        if (before === undefined) return null;
        const current = x - y;
        const previous = stepsDown(before, current, step) ? current + 1 : current - 1;
        const previousX = at(before, previous);
        const previousY = previousX - previous;
        while (x > previousX && y > previousY) {
          x -= 1;
          y -= 1;
        }
        if (x === previousX) {
          y -= 1;
          added[y] = 1;
        } else {
          x -= 1;
          removed[x] = 1;
        }
      }
      return { removed, added };
    }
  }
  return null;
}

/**
 * The changes that turn `current` into `next`, one per run of differing lines,
 * with offsets into `current`. Lines that did not change are never rewritten,
 * so a caret or a fold on them stays where it is.
 */
export function lineChanges(current: string, next: string): TextChange[] {
  if (current === next) return [];
  const a = splitLines(current);
  const b = splitLines(next);
  const countA = a.text.length;
  const countB = b.text.length;

  let prefix = 0;
  while (prefix < countA && prefix < countB && a.text[prefix] === b.text[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < countA - prefix &&
    suffix < countB - prefix &&
    a.text[countA - 1 - suffix] === b.text[countB - 1 - suffix]
  ) {
    suffix += 1;
  }

  const middleA = countA - prefix - suffix;
  const middleB = countB - prefix - suffix;
  const ids = new Map<string, number>();
  const idOf = (line: string | undefined) => {
    const key = line ?? "";
    const known = ids.get(key);
    if (known !== undefined) return known;
    ids.set(key, ids.size);
    return ids.size - 1;
  };
  const idsA = Int32Array.from({ length: middleA }, (_, index) => idOf(a.text[prefix + index]));
  const idsB = Int32Array.from({ length: middleB }, (_, index) => idOf(b.text[prefix + index]));
  const differing = differingLines(idsA, idsB) ?? {
    removed: new Uint8Array(middleA).fill(1),
    added: new Uint8Array(middleB).fill(1),
  };

  const changes: TextChange[] = [];
  let lineA = 0;
  let lineB = 0;
  while (lineA < middleA || lineB < middleB) {
    if (differing.removed[lineA] !== 1 && differing.added[lineB] !== 1) {
      lineA += 1;
      lineB += 1;
      continue;
    }
    const fromA = prefix + lineA;
    const fromB = prefix + lineB;
    while (differing.removed[lineA] === 1 || differing.added[lineB] === 1) {
      if (differing.removed[lineA] === 1) lineA += 1;
      if (differing.added[lineB] === 1) lineB += 1;
    }
    const toA = prefix + lineA;
    const inserted = b.text.slice(fromB, prefix + lineB);
    const startA = a.start[fromA] ?? 0;
    if (toA < countA) {
      // A kept line follows: swap whole lines, each with its own line break.
      changes.push({
        from: startA,
        to: a.start[toA] ?? current.length,
        insert: inserted.map((line) => `${line}\n`).join(""),
      });
    } else if (fromA === 0) {
      changes.push({ from: 0, to: current.length, insert: inserted.join("\n") });
    } else {
      // The run reaches the end of the file: take the line break before it instead.
      changes.push({
        from: startA - 1,
        to: current.length,
        insert: inserted.map((line) => `\n${line}`).join(""),
      });
    }
  }
  return changes;
}
