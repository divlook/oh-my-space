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

type OperationObservation =
  | { kind: "idle" }
  | { kind: "active"; label: string }
  | { kind: "unreadable"; marker: string; access: boolean };

function inspectOperations(dir: string, strict: boolean, includeSequencer: boolean): OperationObservation {
  for (const [marker, label] of operationMarkers) {
    if (!includeSequencer && marker === "sequencer") continue;
    const path = runGit(dir, ["rev-parse", "--git-path", marker]);
    if (strict) {
      if (!path.success || path.stderr.trim() || !path.stdout.trim()) return { kind: "unreadable", marker, access: false };
      try {
        lstatSync(resolve(dir, path.stdout.trim()));
        return { kind: "active", label };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { kind: "unreadable", marker, access: true };
      }
    } else if (path.success && existsSync(resolve(dir, path.stdout.trim()))) {
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
