import { log } from "@clack/prompts";
import { resolve, sep } from "node:path";
import { TREE_DIRNAME } from "./constants.js";

export function insideTreePath(tree: string, cwd: string = process.cwd()): boolean {
  const root = resolve(tree);
  const current = resolve(cwd);
  return current === root || current.startsWith(`${root}${sep}`);
}

export function insideManagedTree(repoRoot: string, cwd: string = process.cwd()): boolean {
  return insideTreePath(resolve(repoRoot, TREE_DIRNAME), cwd);
}

export function refuseInsideManagedTree(repoRoot: string): boolean {
  if (!insideManagedTree(repoRoot)) return false;
  log.error(
    "This command ran from inside a managed tree (.oms-tree/). Use Git directly inside the tree; " +
      "run oms commands from the canonical checkout (oms/<alias>/) or the workspace root.",
  );
  return true;
}
