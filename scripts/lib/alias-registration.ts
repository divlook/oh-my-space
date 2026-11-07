import { existsSync } from "node:fs";
import { join } from "node:path";
import { isRegisteredSubmodule, runGit, submodulePath } from "./git.js";
import { gitlinkState } from "./workspace-state.js";

export type AliasRegistration =
  | "initialized"
  | "registered-uninitialized"
  | "partially registered"
  | "unregistered"
  /** The root index could not be read, so no classification is possible. Distinct from a genuine
   * inconsistency: the state is unknown, not wrong, and the remedy is to retry rather than repair. */
  | "indeterminate";
function snapshotRegisters(repoRoot: string, alias: string, snapshot: "HEAD" | "index"): boolean {
  const path = submodulePath(alias);
  const configArgs = snapshot === "HEAD" ? ["--blob", "HEAD:.gitmodules"] : ["--blob", ":0:.gitmodules"];
  const result = runGit(repoRoot, ["config", ...configArgs, "--get-all", `submodule.${path}.path`]);
  return result.success && result.stdout.split("\n").map((value) => value.trim()).filter(Boolean).length === 1
    && result.stdout.trim() === path;
}

export function aliasRegistration(repoRoot: string, alias: string): AliasRegistration {
  const state = gitlinkState(repoRoot, alias);
  const path = submodulePath(alias);
  // A failed read is not evidence of absence. Without this, an unreadable index makes every
  // registration probe return false, and the mixed result reads as a genuine inconsistency.
  const conflicts = runGit(repoRoot, ["ls-files", "-u", "--", ".gitmodules"]);
  if (!conflicts.success) return "indeterminate";
  if (state.conflict || conflicts.stdout.trim().length > 0) return "partially registered";

  const gitlinks = [state.headOid !== null, state.indexOid !== null, state.indexOid !== null && state.pathExists];
  const worktreeConfigReadable = runGit(repoRoot, ["config", "--file", ".gitmodules", "--list"]).success;
  const worktreeRegistration = isRegisteredSubmodule(repoRoot, path)
    || (state.initialized
      && existsSync(join(repoRoot, ".gitmodules"))
      && !worktreeConfigReadable
      && snapshotRegisters(repoRoot, alias, "HEAD")
      && snapshotRegisters(repoRoot, alias, "index"));
  const registrations = [
    snapshotRegisters(repoRoot, alias, "HEAD"),
    snapshotRegisters(repoRoot, alias, "index"),
    worktreeRegistration,
  ];
  if (gitlinks.every(Boolean) && registrations.every(Boolean)) {
    return state.initialized ? "initialized" : "registered-uninitialized";
  }
  if ([...gitlinks, ...registrations].every((present) => !present)) return "unregistered";
  return "partially registered";
}
