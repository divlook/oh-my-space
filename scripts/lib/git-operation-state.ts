import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { runGit } from "./git.js";

const operationMarkers: readonly (readonly [string, string])[] = [
  ["MERGE_HEAD", "merge"],
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["BISECT_LOG", "bisect"],
  ["sequencer", "cherry-pick or revert"],
];
const sourcePathArgs = ["rev-parse", ...operationMarkers.flatMap(([marker]) => ["--git-path", marker])];

type OperationObservation =
  | { kind: "idle" }
  | { kind: "active"; label: string }
  | { kind: "unreadable"; marker: string; access: boolean };

export function inspectSourceOperations(dir: string, probe: "strict" | "individual-fallback" = "strict"): OperationObservation {
  const lookup = runGit(dir, sourcePathArgs);
  const paths = lookup.stdout.slice(0, -1).split("\n");
  const usable = lookup.success && !lookup.stderr.trim() && lookup.stdout.endsWith("\n") && paths.length >= operationMarkers.length;
  if (!usable && probe === "strict") {
    return { kind: "unreadable", marker: operationMarkers[0][0], access: false };
  }
  // Git's newline-delimited path output is ambiguous when a gitdir contains newlines.
  const batched = usable && paths.length === operationMarkers.length;
  for (const [index, [marker, label]] of operationMarkers.entries()) {
    let path: string;
    if (batched) {
      path = paths[index];
    } else {
      const result = runGit(dir, ["rev-parse", "--git-path", marker]);
      if (!result.success || result.stderr.trim() || !result.stdout.endsWith("\n")) return { kind: "unreadable", marker, access: false };
      path = result.stdout.slice(0, -1);
    }
    if (!path) return { kind: "unreadable", marker, access: false };
    try {
      lstatSync(resolve(dir, path));
      return { kind: "active", label };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { kind: "unreadable", marker, access: true };
    }
  }
  return { kind: "idle" };
}
