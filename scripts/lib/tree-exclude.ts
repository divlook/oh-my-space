import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GITIGNORE_COMMENT, TREE_EXCLUDE_ENTRY } from "./constants.js";
import { LOCAL_EXCLUDE_PATH, updateLocalExclude } from "./local-exclude.js";
import type { SourceWorkspace } from "./source-checkout.js";

function hasTreeExcludeEntry(content: string): boolean {
  return content
    .split("\n")
    .some((line) => line.trim() === TREE_EXCLUDE_ENTRY || line.trim() === `/${TREE_EXCLUDE_ENTRY}`);
}

export function rootExcludeEntryPresent(workspace: SourceWorkspace): boolean {
  const path = join(workspace.commonDir, LOCAL_EXCLUDE_PATH);
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return false;
  if (!entry.isFile()) throw new Error(`${path} is not a regular file`);
  return hasTreeExcludeEntry(readFileSync(path, "utf8"));
}

export function ensureTreeExcluded(workspace: SourceWorkspace): void {
  if (rootExcludeEntryPresent(workspace)) return;
  updateLocalExclude(workspace.commonDir, 0o666, (before) => {
    if (hasTreeExcludeEntry(before.toString("utf8"))) return null;
    let end = before.length;
    while (end > 0 && before[end - 1] === 10) end--;
    return [before.subarray(0, end), `${end ? "\n" : ""}${GITIGNORE_COMMENT}\n${TREE_EXCLUDE_ENTRY}\n`];
  });
}
