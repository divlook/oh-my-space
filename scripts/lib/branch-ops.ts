import { log } from "@clack/prompts";
import {
  listLocalBranches,
  listRemoteBranches,
  localBranchExists,
  remoteBranchExists,
  runSub,
  redactingGitRunner,
} from "./git.js";
import { pickBranch } from "./prompts.js";
import { prepareBranchSource, requireSource } from "./source-preparation.js";
import { loadForSources } from "./source-workspace.js";
import type { CheckoutOptions } from "./types.js";
import { refuseInsideManagedTree } from "./tree-context.js";

async function switchExisting(repoRoot: string, alias: string, target: string): Promise<number> {
  log.step(`${alias}: git switch ${target}`);
  const result = runSub(repoRoot, alias, ["switch", "--no-guess", "--", target], true);
  if (!result.success) return 2;
  log.success(`${alias}: on ${target}`);
  return 0;
}

/** Local creation does not fetch or configure upstream tracking. */
export async function runSourceSwitch(alias: string | undefined, branch: string | undefined, options: CheckoutOptions): Promise<number> {
  const loaded = loadForSources();
  if (!loaded || refuseInsideManagedTree(loaded.repoRoot)) return 1;
  const { workspace, repoRoot, repos } = loaded;
  const prepared = await prepareBranchSource(workspace, repos, alias, "branch switch");
  if ("code" in prepared) return prepared.code;
  const { repo, checkout: { path: dir } } = prepared;

  let target = branch;
  if (!target) {
    const picked = await pickBranch(listLocalBranches(dir), `${repo.alias}: select a local branch`, true);
    if (!picked) return 1;
    target = picked;
    if (!requireSource(workspace, repo)) return 1;
  }

  if (localBranchExists(dir, target)) return switchExisting(repoRoot, repo.alias, target);

  const args = ["switch", "--no-track", "-c", target, ...(options.from ? ["--", options.from] : [])];
  log.step(`${repo.alias}: git ${args.join(" ")}`);
  const r = runSub(repoRoot, repo.alias, args, true);
  if (!r.success) return 2;
  log.success(`${repo.alias}: created new local branch ${target}. Push it with "oms push ${repo.alias}".`);
  return 0;
}

/** Remote exploration refreshes origin even when an existing local counterpart is selected. */
export async function runSourceCheckout(alias: string | undefined, branch: string | undefined): Promise<number> {
  const loaded = loadForSources();
  if (!loaded || refuseInsideManagedTree(loaded.repoRoot)) return 1;
  const { workspace, repoRoot, repos } = loaded;
  const prepared = await prepareBranchSource(workspace, repos, alias, "branch checkout");
  if ("code" in prepared) return prepared.code;
  const { repo, checkout: { path: dir } } = prepared;

  log.step(`${repo.alias}: git fetch origin --prune`);
  const fetch = runSub(repoRoot, repo.alias, ["fetch", "origin", "--prune"], true, redactingGitRunner);
  if (!fetch.success) return 2;

  let target = branch;
  if (!target) {
    const picked = await pickBranch(listRemoteBranches(dir), `${repo.alias}: select a remote branch (origin/*)`, false);
    if (!picked) return 1;
    target = picked;
    if (!requireSource(workspace, repo)) return 1;
  }

  if (localBranchExists(dir, target)) return switchExisting(repoRoot, repo.alias, target);
  if (remoteBranchExists(dir, target)) {
    log.step(`${repo.alias}: git switch -c ${target} origin/${target}`);
    const r = runSub(repoRoot, repo.alias, ["switch", "--track", "-c", target, "--", `refs/remotes/origin/${target}`], true);
    if (!r.success) return 2;
    log.success(`${repo.alias}: on ${target} (tracking origin/${target})`);
    return 0;
  }

  log.error(
    `${repo.alias}: "${target}" not found on origin. To create a new local branch, run "oms branch switch ${repo.alias} ${target}".`,
  );
  return 1;
}
