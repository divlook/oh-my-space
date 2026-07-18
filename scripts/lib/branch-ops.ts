import { log } from "@clack/prompts";
import {
  aliasDir,
  listLocalBranches,
  listRemoteBranches,
  localBranchExists,
  remoteBranchExists,
  runGit,
  runSub,
} from "./git.js";
import { loadForSubmodules, loadRepos } from "./manifest.js";
import { pickBranch, resolveInitializedAlias } from "./prompts.js";
import { guardedText, isCancel } from "./prompt-adapter.js";
import type { CheckoutOptions } from "./types.js";
import { commonRepoPath } from "./worktree-paths.js";
import { inspectWorktreeInventory } from "./worktree-inspection.js";
import { readWorkspaceOwnership } from "./workspace-mutation.js";
import { resolveWorktreeTarget } from "./worktree-target.js";
import { fetchSelectedWorktreeRemote } from "./worktree-ops.js";

async function resolveBranchInput(alias: string, branch: string | undefined): Promise<string | null> {
  if (branch) return branch;
  const value = await guardedText({
    message: `${alias}: enter a branch name`,
    validate: (input) => (input ?? "").trim().length > 0 ? undefined : "Branch is required.",
  });
  return isCancel(value) ? null : value.trim();
}

function checkedOutElsewhere(workspaceRoot: string, alias: string, branch: string, currentPath: string): string | null {
  const ownership = readWorkspaceOwnership(workspaceRoot);
  if (!ownership) return null;
  const match = inspectWorktreeInventory(workspaceRoot, alias, ownership.workspaceId).worktrees
    .find((entry) => entry.branch === branch && entry.path !== currentPath);
  return match?.path ?? null;
}

async function runWorktreeSwitch(
  targetValue: string | undefined,
  branch: string | undefined,
  options: CheckoutOptions,
): Promise<number> {
  const loaded = loadRepos();
  if (!loaded || loaded.mode !== "worktree") return 1;
  const selected = await resolveWorktreeTarget(loaded.repoRoot, loaded.repos, targetValue, "branch-switch");
  if (!selected) return 1;
  const target = await resolveBranchInput(selected.target.alias, branch);
  if (!target) return 1;
  const occupied = checkedOutElsewhere(loaded.repoRoot, selected.repo.alias, target, selected.entry.path);
  if (occupied) {
    log.error(`${selected.repo.alias}: branch ${target} is already checked out at ${occupied}`);
    return 1;
  }
  const common = commonRepoPath(loaded.repoRoot, selected.repo.alias);
  const exists = runGit(common, ["rev-parse", "--verify", `refs/heads/${target}^{commit}`]).success;
  const args = exists
    ? ["switch", target]
    : ["switch", "-c", target, ...(options.from ? [options.from] : [])];
  if (!runGit(selected.entry.path, args, true).success) return 2;
  log.success(`${selected.target.alias}/${selected.target.name}: on ${target}`);
  return 0;
}

async function runWorktreeCheckout(
  targetValue: string | undefined,
  branch: string | undefined,
  options: { remote?: string },
): Promise<number> {
  const loaded = loadRepos();
  if (!loaded || loaded.mode !== "worktree") return 1;
  const selected = await resolveWorktreeTarget(loaded.repoRoot, loaded.repos, targetValue, "branch-checkout");
  if (!selected) return 1;
  const target = await resolveBranchInput(selected.target.alias, branch);
  if (!target) return 1;
  const remote = options.remote ?? "origin";
  if (!(remote in selected.repo.remotes)) {
    log.error(`${selected.repo.alias}: remote "${remote}" is not declared in oms.yaml`);
    return 1;
  }
  const occupied = checkedOutElsewhere(loaded.repoRoot, selected.repo.alias, target, selected.entry.path);
  if (occupied) {
    log.error(`${selected.repo.alias}: branch ${target} is already checked out at ${occupied}`);
    return 1;
  }
  const common = commonRepoPath(loaded.repoRoot, selected.repo.alias);
  const fetched = fetchSelectedWorktreeRemote(loaded.repoRoot, common, selected.repo, remote, target);
  if (!fetched.ok) {
    log.error(`${selected.repo.alias}: fetch ${remote} failed; branch was not changed`);
    return 2;
  }
  const local = runGit(common, ["rev-parse", "--verify", `refs/heads/${target}^{commit}`]).success;
  if (local) {
    if (!runGit(selected.entry.path, ["switch", target], true).success) return 2;
  } else if (fetched.remoteOid) {
    if (!runGit(selected.entry.path, ["switch", "-c", target, "--track", `${remote}/${target}`], true).success) return 2;
  } else {
    log.error(`${selected.repo.alias}: branch ${target} is unavailable on ${remote}`);
    return 1;
  }
  log.success(`${selected.target.alias}/${selected.target.name}: on ${target} (tracking ${remote}/${target})`);
  return 0;
}

/**
 * LOCAL branch management: switch the submodule to an existing local branch or create a new one.
 * No remote is consulted — creating a brand-new branch needs no remote precondition and sets no
 * upstream (that is checkout's job). Omitting alias and/or branch prompts for them interactively.
 */
export async function runSwitch(
  alias: string | undefined,
  branch: string | undefined,
  options: CheckoutOptions,
): Promise<number> {
  const mode = loadRepos();
  if (mode?.mode === "worktree") return runWorktreeSwitch(alias, branch, options);
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  const repo = await resolveInitializedAlias(repos, repoRoot, alias, "branch switch");
  if (!repo) return 1;
  const dir = aliasDir(repoRoot, repo.alias);

  let target = branch;
  if (!target) {
    const picked = await pickBranch(listLocalBranches(dir), `${repo.alias}: select a local branch`, true);
    if (!picked) return 1;
    target = picked;
  }

  if (localBranchExists(dir, target)) {
    log.step(`${repo.alias}: git switch ${target}`);
    const r = runSub(repoRoot, repo.alias, ["switch", target], true);
    if (!r.success) return 2;
    log.success(`${repo.alias}: on ${target}`);
    return 0;
  }

  // Brand-new local branch: no remote precondition, no upstream tracking (use "oms branch checkout" for that).
  const args = ["switch", "-c", target, ...(options.from ? [options.from] : [])];
  log.step(`${repo.alias}: git ${args.join(" ")}`);
  const r = runSub(repoRoot, repo.alias, args, true);
  if (!r.success) return 2;
  log.success(`${repo.alias}: created new local branch ${target}. Push it with "oms push ${repo.alias}".`);
  return 0;
}

/**
 * REMOTE branch exploration: fetch origin, then check out a remote branch as a local tracking
 * branch (or switch to an existing local counterpart). Omitting alias and/or branch prompts for
 * them interactively. Creating brand-new local branches is "oms branch switch"'s job.
 */
export async function runCheckout(
  alias: string | undefined,
  branch: string | undefined,
  options: { remote?: string } = {},
): Promise<number> {
  const mode = loadRepos();
  if (mode?.mode === "worktree") return runWorktreeCheckout(alias, branch, options);
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  const repo = await resolveInitializedAlias(repos, repoRoot, alias, "branch checkout");
  if (!repo) return 1;
  const dir = aliasDir(repoRoot, repo.alias);

  log.step(`${repo.alias}: git fetch origin --prune`);
  const fetch = runSub(repoRoot, repo.alias, ["fetch", "origin", "--prune"], true);
  if (!fetch.success) return 2;

  let target = branch;
  if (!target) {
    const picked = await pickBranch(listRemoteBranches(dir), `${repo.alias}: select a remote branch (origin/*)`, false);
    if (!picked) return 1;
    target = picked;
  }

  if (localBranchExists(dir, target)) {
    log.step(`${repo.alias}: git switch ${target}`);
    const r = runSub(repoRoot, repo.alias, ["switch", target], true);
    if (!r.success) return 2;
    log.success(`${repo.alias}: on ${target}`);
    return 0;
  }
  if (remoteBranchExists(dir, target)) {
    log.step(`${repo.alias}: git switch -c ${target} origin/${target}`);
    const r = runSub(repoRoot, repo.alias, ["switch", "-c", target, `origin/${target}`], true);
    if (!r.success) return 2;
    log.success(`${repo.alias}: on ${target} (tracking origin/${target})`);
    return 0;
  }

  log.error(
    `${repo.alias}: "${target}" not found on origin. To create a new local branch, run "oms branch switch ${repo.alias} ${target}".`,
  );
  return 1;
}
