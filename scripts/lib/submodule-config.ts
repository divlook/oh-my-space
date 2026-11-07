import { aliasDir, currentBranch, localBranchExists, productionGitRunner, redactSensitiveUrls, remoteBranchExists, runGit, runSub, submodulePath, type RawGitRunner } from "./git.js";

export function gitmodulesBranch(repoRoot: string, alias: string, runner: RawGitRunner = productionGitRunner): string | null {
  const r = runGit(repoRoot, [
    "config",
    "--file",
    ".gitmodules",
    "--get",
    `submodule.${submodulePath(alias)}.branch`,
  ], false, undefined, runner);
  if (!r.success) return null;
  const b = r.stdout.trim();
  return b.length > 0 ? b : null;
}

type AttachBranchResult =
  | { kind: "already-attached"; branch: string }
  | { kind: "attached"; branch: string }
  | { kind: "diverged"; branch: string; headOid: string; branchOid: string }
  | { kind: "failed"; branch: string; diagnostic: string };

/**
 * Keep the submodule on a branch instead of a detached HEAD. Only acts when HEAD is detached,
 * so a branch the user is already working on is never disturbed. When no local branch exists
 * yet, a branch is created at the current (pinned) commit — the checked-out commit is preserved,
 * which keeps the parent's recorded pointer reproducible.
 */
export function attachBranch(repoRoot: string, alias: string, branch: string, runner: RawGitRunner = productionGitRunner): AttachBranchResult {
  const dir = aliasDir(repoRoot, alias);
  if (currentBranch(dir, runner) !== null) return { kind: "already-attached", branch };

  const head = runGit(dir, ["rev-parse", "--verify", "HEAD^{commit}"], false, undefined, runner);
  const headOid = head.stdout.trim();
  if (!head.success || !/^[0-9a-f]{40}$/.test(headOid)) {
    return {
      kind: "failed",
      branch,
      diagnostic: redactSensitiveUrls(head.stderr.trim()) || "could not resolve detached HEAD",
    };
  }

  if (localBranchExists(dir, branch, runner)) {
    const tip = runGit(dir, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], false, undefined, runner);
    const branchOid = tip.stdout.trim();
    if (!tip.success || !/^[0-9a-f]{40}$/.test(branchOid)) {
      return {
        kind: "failed",
        branch,
        diagnostic: redactSensitiveUrls(tip.stderr.trim()) || `could not resolve local branch "${branch}"`,
      };
    }
    if (branchOid !== headOid) return { kind: "diverged", branch, headOid, branchOid };

    const switched = runSub(repoRoot, alias, ["switch", branch], false, runner);
    if (!switched.success) {
      return {
        kind: "failed",
        branch,
        diagnostic: redactSensitiveUrls(switched.stderr.trim()) || `git switch "${branch}" failed`,
      };
    }
    return { kind: "attached", branch };
  }

  const created = runSub(repoRoot, alias, ["switch", "-c", branch], false, runner);
  if (!created.success) {
    return {
      kind: "failed",
      branch,
      diagnostic: redactSensitiveUrls(created.stderr.trim()) || `git switch -c "${branch}" failed`,
    };
  }
  if (remoteBranchExists(dir, branch, runner)) {
    runSub(repoRoot, alias, ["branch", "--set-upstream-to", `origin/${branch}`, branch], false, runner);
  }
  return { kind: "attached", branch };
}

/**
 * Reconcile the submodule's git remotes with the declared `remotes` map: add missing remotes and
 * update URLs that drifted. Non-destructive — remotes no longer in oms.yaml are left untouched.
 */
type RemoteReconciliation = { name: string; ok: true } | { name: string; ok: false; diagnostic: string };

export function ensureRemotes(
  repoRoot: string,
  alias: string,
  remotes: Record<string, string>,
  runner: RawGitRunner = productionGitRunner,
): RemoteReconciliation[] {
  const results: RemoteReconciliation[] = [];
  for (const [name, url] of Object.entries(remotes)) {
    const existing = runSub(repoRoot, alias, ["remote", "get-url", name], false, runner);
    if (!existing.success) {
      const added = runSub(repoRoot, alias, ["remote", "add", name, url], false, runner);
      results.push(added.success
        ? { name, ok: true }
        : { name, ok: false, diagnostic: redactSensitiveUrls(added.stderr.trim()) });
    } else if (existing.stdout.trim() !== url) {
      const updated = runSub(repoRoot, alias, ["remote", "set-url", name, url], false, runner);
      results.push(updated.success
        ? { name, ok: true }
        : { name, ok: false, diagnostic: redactSensitiveUrls(updated.stderr.trim()) });
    } else {
      results.push({ name, ok: true });
    }
  }
  return results;
}
