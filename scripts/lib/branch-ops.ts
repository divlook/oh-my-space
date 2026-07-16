import { log } from "@clack/prompts";
import {
  aliasDir,
  listLocalBranches,
  listRemoteBranches,
  localBranchExists,
  remoteBranchExists,
  runSub,
} from "./git.js";
import { loadForSubmodules } from "./manifest.js";
import { pickBranch, resolveInitializedAlias } from "./prompts.js";
import type { CheckoutOptions } from "./types.js";

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
export async function runCheckout(alias: string | undefined, branch: string | undefined): Promise<number> {
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
