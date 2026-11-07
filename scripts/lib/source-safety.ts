import { aliasDir, currentBranch, runGit } from "./git.js";
import { gitlinkState } from "./workspace-state.js";
import { inspectSourceOperations, submoduleOperationInProgress } from "./git-operation-state.js";
import type { Repo } from "./types.js";

type Safety = { ok: true } | { ok: false; reason: string };

/** Deletion retains permissive marker/branch probes; cleanup below fails closed. */
export function checkDeleteSourceSafety(repoRoot: string, repo: Repo): Safety {
  const dir = aliasDir(repoRoot, repo.alias);
  const op = submoduleOperationInProgress(dir);
  if (op) return { ok: false, reason: `${repo.alias}: a ${op} is in progress inside oms/${repo.alias}. Resolve, continue, or abort it first.` };
  if (currentBranch(dir) === null) {
    const state = gitlinkState(repoRoot, repo.alias);
    if (!anchored(state.headOid, state.worktreeOid)) return { ok: false, reason: detachedReason(repo.alias) };
  }
  return { ok: true };
}

function anchored(recorded: string | null, head: string | null): boolean {
  return recorded !== null && head !== null && recorded === head;
}
function detachedReason(alias: string): string {
  return `${alias}: submodule HEAD is detached and not anchored to the recorded gitlink. Attach it with "oms branch switch ${alias} <branch>" first.`;
}

/** Dirty files and staged root pointers are allowed; only root HEAD anchors detachment. */
export function inspectCleanSourceSafety(dir: string, alias: string, recorded: string): string | null {
  const operation = inspectSourceOperations(dir);
  if (operation.kind === "active") return `${alias}: a ${operation.label} is in progress. Resolve, continue, or abort it first.`;
  if (operation.kind === "unreadable") return operation.access
    ? `Cannot inspect source operation marker ${operation.marker}; resolve filesystem access, then retry.`
    : `Cannot inspect source operation marker ${operation.marker}; retry once Git is idle.`;
  const head = runGit(dir, ["rev-parse", "--verify", "HEAD"]);
  if (!head.success || head.stderr.trim() || !/^[0-9a-f]{40,64}$/.test(head.stdout.trim())) return "Cannot inspect source HEAD; retry once Git is idle.";
  const branch = runGit(dir, ["symbolic-ref", "--quiet", "HEAD"]);
  if ((!branch.success && branch.exitCode !== 1) || branch.stderr.trim() || (branch.success && !/^refs\/heads\/.+$/.test(branch.stdout.trim()))) return "Cannot inspect whether source HEAD is detached; retry once Git is idle.";
  if (branch.exitCode === 1 && !anchored(recorded, head.stdout.trim())) {
    return detachedReason(alias);
  }
  return null;
}
