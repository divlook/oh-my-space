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

/**
 * Keep the submodule on a branch instead of a detached HEAD. Only acts when HEAD is detached,
 * so a branch the user is already working on is never disturbed. When no local branch exists
 * yet, a branch is created at the current (pinned) commit — the checked-out commit is preserved,
 * which keeps the parent's recorded pointer reproducible.
 */
export function attachBranch(repoRoot: string, alias: string, branch: string): void {
  if (currentBranch(aliasDir(repoRoot, alias)) !== null) return;

  if (localBranchExists(aliasDir(repoRoot, alias), branch)) {
    runSub(repoRoot, alias, ["switch", branch]);
    return;
  }
  // Create the branch at the current HEAD (the pinned commit) so the worktree stays put.
  if (!runSub(repoRoot, alias, ["switch", "-c", branch]).success) return;
  if (remoteBranchExists(aliasDir(repoRoot, alias), branch)) {
    runSub(repoRoot, alias, ["branch", "--set-upstream-to", `origin/${branch}`, branch]);
  }
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
