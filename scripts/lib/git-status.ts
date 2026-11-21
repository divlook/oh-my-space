export type ChangeCounts = { staged: number; unstaged: number; untracked: number };

/** Count each porcelain v1 NUL-delimited path, skipping the source of a rename or copy. */
export function parseChangeCounts(output: string, excludePaths?: ReadonlySet<string>): ChangeCounts {
  const counts: ChangeCounts = { staged: 0, unstaged: 0, untracked: 0 };
  let offset = 0;
  while (offset < output.length) {
    const start = offset;
    const nul = output.indexOf("\0", start);
    const end = nul === -1 ? output.length : nul;
    offset = end + 1;
    if (end - start < 3) continue;
    const x = output[start];
    const y = output[start + 1];
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const sourceEnd = output.indexOf("\0", offset);
      offset = sourceEnd === -1 ? output.length : sourceEnd + 1;
    }
    if (excludePaths?.has(output.slice(start + 3, end))) continue;
    if (x === "?" && y === "?") {
      counts.untracked++;
      continue;
    }
    if (x !== " " && x !== "?") counts.staged++;
    if (y !== " " && y !== "?") counts.unstaged++;
  }
  return counts;
}

export function isDirtyCounts(c: ChangeCounts): boolean {
  return c.staged > 0 || c.unstaged > 0 || c.untracked > 0;
}
