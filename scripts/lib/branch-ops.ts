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
import { pickBranch, selectRepoAlias } from "./prompts.js";
import { prepareAlias } from "./alias-preparation.js";
import type { CheckoutOptions } from "./types.js";
import { refuseInsideManagedTree } from "./tree-context.js";

async function switchExisting(repoRoot: string, alias: string, target: string): Promise<number> {
  log.step(`${alias}: git switch ${target}`);
  const result = runSub(repoRoot, alias, ["switch", target], true);
  if (!result.success) return 2;
  log.success(`${alias}: on ${target}`);
  return 0;
}

/** Local creation does not fetch or configure upstream tracking. */
export async function runSwitch(
  alias: string | undefined,
  branch: string | undefined,
  options: CheckoutOptions,
): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;
  if (refuseInsideManagedTree(repoRoot)) return 1;

  const repo = await selectRepoAlias(repos, alias, "branch switch");
  if (!repo) return 1;
  const preparation = await prepareAlias(repoRoot, repo, { command: "branch switch", topologyOffer: true });
  if (!preparation.ok) return 1;
  const dir = aliasDir(repoRoot, repo.alias);

  let target = branch;
  if (!target) {
    const picked = await pickBranch(listLocalBranches(dir), `${repo.alias}: select a local branch`, true);
    if (!picked) return 1;
    target = picked;
  }

  if (localBranchExists(dir, target)) return switchExisting(repoRoot, repo.alias, target);

  const args = ["switch", "-c", target, ...(options.from ? [options.from] : [])];
  log.step(`${repo.alias}: git ${args.join(" ")}`);
  const r = runSub(repoRoot, repo.alias, args, true);
  if (!r.success) return 2;
  log.success(`${repo.alias}: created new local branch ${target}. Push it with "oms push ${repo.alias}".`);
  return 0;
}

/** Remote exploration refreshes origin even when an existing local counterpart is selected. */
export async function runCheckout(alias: string | undefined, branch: string | undefined): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;
  if (refuseInsideManagedTree(repoRoot)) return 1;

  const repo = await selectRepoAlias(repos, alias, "branch checkout");
  if (!repo) return 1;
  const preparation = await prepareAlias(repoRoot, repo, { command: "branch checkout", topologyOffer: true });
  if (!preparation.ok) return 1;
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

  if (localBranchExists(dir, target)) return switchExisting(repoRoot, repo.alias, target);
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
