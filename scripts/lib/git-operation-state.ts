import { existsSync, lstatSync } from "node:fs";
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
const rootOperationMarkers = operationMarkers.filter(([marker]) => marker !== "sequencer");
const sourcePathArgs = ["rev-parse", ...operationMarkers.flatMap(([marker]) => ["--git-path", marker])];
const rootPathArgs = ["rev-parse", ...rootOperationMarkers.flatMap(([marker]) => ["--git-path", marker])];

type OperationObservation =
  | { kind: "idle" }
  | { kind: "active"; label: string }
  | { kind: "unreadable"; marker: string; access: boolean };

function inspectOperations(dir: string, strict: boolean, includeSequencer: boolean): OperationObservation {
  const markers = includeSequencer ? operationMarkers : rootOperationMarkers;
  const lookup = runGit(dir, includeSequencer ? sourcePathArgs : rootPathArgs);
  const paths = lookup.stdout.trimEnd().split("\n");
  if (strict && (!lookup.success || lookup.stderr.trim() || paths.length < markers.length)) {
    return { kind: "unreadable", marker: markers[0][0], access: false };
  }
  // Git's newline-delimited path output is ambiguous when a gitdir contains newlines.
  const batched = lookup.success && paths.length === markers.length;
  for (let index = 0; index < markers.length; index++) {
    const [marker, label] = markers[index];
    let path: string;
    if (batched) {
      path = paths[index].trim();
    } else {
      const result = runGit(dir, ["rev-parse", "--git-path", marker]);
      if (strict && (!result.success || result.stderr.trim())) return { kind: "unreadable", marker, access: false };
      if (!result.success) continue;
      path = result.stdout.trim();
    }
    if (strict) {
      if (!path) return { kind: "unreadable", marker, access: false };
      try {
        lstatSync(resolve(dir, path));
        return { kind: "active", label };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { kind: "unreadable", marker, access: true };
      }
    } else if (existsSync(resolve(dir, path))) {
      return { kind: "active", label };
    }
  }
  return { kind: "idle" };
}

export function gitOperationInProgress(dir: string): string | null {
  const observation = inspectOperations(dir, false, false);
  return observation.kind === "active" ? observation.label : null;
}

export function submoduleOperationInProgress(dir: string): string | null {
  const observation = inspectOperations(dir, false, true);
  return observation.kind === "active" ? observation.label : null;
}

export function inspectSourceOperations(dir: string): OperationObservation {
  return inspectOperations(dir, true, true);
}
