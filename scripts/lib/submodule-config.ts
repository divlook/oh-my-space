import { aliasDir, currentBranch, localBranchExists, redactSensitiveUrls, remoteBranchExists, runGit, runSub, submodulePath } from "./git.js";

/** The branch recorded in .gitmodules for the submodule, if any. */
export function gitmodulesBranch(repoRoot: string, alias: string): string | null {
  const r = runGit(repoRoot, [
    "config",
    "--file",
    ".gitmodules",
    "--get",
    `submodule.${submodulePath(alias)}.branch`,
  ]);
  if (!r.success) return null;
  const b = r.stdout.trim();
  return b.length > 0 ? b : null;
}

/** Outcome of attaching a detached submodule without changing its checked-out commit. */
export type AttachBranchResult =
  | { kind: "already-attached"; branch: string }
  | { kind: "attached"; branch: string; oid: string }
  | { kind: "diverged"; branch: string; headOid: string; branchOid: string }
  | { kind: "failed"; branch: string; diagnostic: string };

/**
 * Keep the submodule on a branch instead of a detached HEAD. Only acts when HEAD is detached,
 * so a branch the user is already working on is never disturbed. When no local branch exists
 * yet, a branch is created at the current (pinned) commit — the checked-out commit is preserved,
 * which keeps the parent's recorded pointer reproducible.
 */
export function attachBranch(repoRoot: string, alias: string, branch: string): AttachBranchResult {
  const dir = aliasDir(repoRoot, alias);
  const current = currentBranch(dir);
  if (current !== null) return { kind: "already-attached", branch: current };

  const head = runGit(dir, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const headOid = head.stdout.trim();
  if (!head.success || !/^[0-9a-f]{40}$/.test(headOid)) {
    return {
      kind: "failed",
      branch,
      diagnostic: redactSensitiveUrls(head.stderr.trim()) || "could not resolve detached HEAD",
    };
  }

  if (localBranchExists(dir, branch)) {
    const tip = runGit(dir, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
    const branchOid = tip.stdout.trim();
    if (!tip.success || !/^[0-9a-f]{40}$/.test(branchOid)) {
      return {
        kind: "failed",
        branch,
        diagnostic: redactSensitiveUrls(tip.stderr.trim()) || `could not resolve local branch "${branch}"`,
      };
    }
    if (branchOid !== headOid) return { kind: "diverged", branch, headOid, branchOid };

    const switched = runSub(repoRoot, alias, ["switch", branch]);
    if (!switched.success) {
      return {
        kind: "failed",
        branch,
        diagnostic: redactSensitiveUrls(switched.stderr.trim()) || `git switch "${branch}" failed`,
      };
    }
    return { kind: "attached", branch, oid: headOid };
  }

  // Create the branch at the current HEAD (the pinned commit) so the worktree stays put.
  const created = runSub(repoRoot, alias, ["switch", "-c", branch]);
  if (!created.success) {
    return {
      kind: "failed",
      branch,
      diagnostic: redactSensitiveUrls(created.stderr.trim()) || `git switch -c "${branch}" failed`,
    };
  }
  if (remoteBranchExists(dir, branch)) {
    runSub(repoRoot, alias, ["branch", "--set-upstream-to", `origin/${branch}`, branch]);
  }
  return { kind: "attached", branch, oid: headOid };
}

/**
 * Reconcile the submodule's git remotes with the declared `remotes` map: add missing remotes and
 * update URLs that drifted. Non-destructive — remotes no longer in oms.yaml are left untouched.
 */
export type RemoteReconciliation = { name: string; ok: true } | { name: string; ok: false; diagnostic: string };

export function ensureRemotes(
  repoRoot: string,
  alias: string,
  remotes: Record<string, string>,
): RemoteReconciliation[] {
  const results: RemoteReconciliation[] = [];
  for (const [name, url] of Object.entries(remotes)) {
    const existing = runSub(repoRoot, alias, ["remote", "get-url", name]);
    if (!existing.success) {
      const added = runSub(repoRoot, alias, ["remote", "add", name, url]);
      results.push(added.success
        ? { name, ok: true }
        : { name, ok: false, diagnostic: redactSensitiveUrls(added.stderr.trim()) });
    } else if (existing.stdout.trim() !== url) {
      const updated = runSub(repoRoot, alias, ["remote", "set-url", name, url]);
      results.push(updated.success
        ? { name, ok: true }
        : { name, ok: false, diagnostic: redactSensitiveUrls(updated.stderr.trim()) });
    } else {
      results.push({ name, ok: true });
    }
  }
  return results;
}
