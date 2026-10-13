import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { aliasDir, currentBranch, runGit } from "./git.js";
import { gitlinkState, submoduleOperationInProgress } from "./status.js";
import type { Repo } from "./types.js";

type Safety = { ok: true } | { ok: false; reason: string };

/** Legacy deletion policy: operation markers and detached root-HEAD anchoring; unchanged probes. */
export function checkDeleteSourceSafety(repoRoot: string, repo: Repo): Safety {
  const dir = aliasDir(repoRoot, repo.alias);
  const op = submoduleOperationInProgress(dir);
  if (op) return { ok: false, reason: `${repo.alias}: a ${op} is in progress inside oms/${repo.alias}. Resolve, continue, or abort it first.` };
  if (currentBranch(dir) === null) {
    const state = gitlinkState(repoRoot, repo.alias);
    if (!anchored(state.headOid, state.worktreeOid)) return detached(repo.alias);
  }
  return { ok: true };
}

function anchored(recorded: string | null, head: string | null): boolean {
  return recorded !== null && head !== null && recorded === head;
}
function detached(alias: string): Safety {
  return { ok: false, reason: `${alias}: submodule HEAD is detached and not anchored to the recorded gitlink. Attach it with "oms branch switch ${alias} <branch>" first.` };
}

/** Cleanup refuses any failed marker/HEAD inspection, operations (including sequencer), or
 * detached HEAD different from the root HEAD gitlink. Dirty files and staged root pointers are allowed.
 * Unlike the legacy deletion probes, errors are never interpreted as idle or detached state.
 */
export function inspectCleanSourceSafety(dir: string, alias: string, recorded: string): string | null {
  for (const [marker, label] of [
    ["MERGE_HEAD", "merge"], ["rebase-merge", "rebase"], ["rebase-apply", "rebase"],
    ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"],
    ["BISECT_LOG", "bisect"], ["sequencer", "cherry-pick or revert"],
  ]) {
    const path = runGit(dir, ["rev-parse", "--git-path", marker]);
    if (!path.success || path.stderr.trim() || !path.stdout.trim()) return `Cannot inspect source operation marker ${marker}; retry once Git is idle.`;
    try {
      lstatSync(resolve(dir, path.stdout.trim()));
      return `${alias}: a ${label} is in progress. Resolve, continue, or abort it first.`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return `Cannot inspect source operation marker ${marker}; resolve filesystem access, then retry.`;
    }
  }
  const head = runGit(dir, ["rev-parse", "--verify", "HEAD"]);
  if (!head.success || head.stderr.trim() || !/^[0-9a-f]{40,64}$/.test(head.stdout.trim())) return "Cannot inspect source HEAD; retry once Git is idle.";
  const branch = runGit(dir, ["symbolic-ref", "--quiet", "HEAD"]);
  if ((!branch.success && branch.exitCode !== 1) || branch.stderr.trim() || (branch.success && !/^refs\/heads\/.+$/.test(branch.stdout.trim()))) return "Cannot inspect whether source HEAD is detached; retry once Git is idle.";
  if (branch.exitCode === 1 && !anchored(recorded, head.stdout.trim())) {
    const refusal = detached(alias);
    return refusal.ok ? null : refusal.reason;
  }
  return null;
}
