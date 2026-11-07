import { log } from "@clack/prompts";
import { aliasDir, currentBranch, isDirty, runSub } from "./git.js";
import { prepareAliases, resolveDetachedHead } from "./alias-preparation.js";
import { loadForSubmodules } from "./manifest.js";
import { exitFromResults, printSummary } from "./operation-results.js";
import { resolveRemotes, selectRepos } from "./prompts.js";
import { printRootFollowups } from "./status.js";
import type { ManageCommand, OperationResult, RemoteOptions, Repo, SourcesOptions } from "./types.js";
import { refuseInsideManagedTree } from "./tree-context.js";

function fetchRepo(repo: Repo, repoRoot: string, remotes: string[]): OperationResult {
  for (const remote of remotes) {
    log.step(`${repo.alias}: git fetch ${remote} --prune`);
    let r = runSub(repoRoot, repo.alias, ["fetch", remote, "--prune"], true);
    if (!r.success) r = runSub(repoRoot, repo.alias, ["fetch", remote, "--prune"], true);
    if (!r.success) {
      log.error(`${repo.alias}: fetch ${remote} failed (exit ${r.exitCode})`);
      return "failed";
    }
  }
  log.success(`${repo.alias}: fetched (${remotes.join(", ")})`);
  return "fetched";
}

function pullRepo(repo: Repo, repoRoot: string, remote: string, branch: string): OperationResult {
  if (isDirty(aliasDir(repoRoot, repo.alias))) {
    log.error(
      `${repo.alias}: submodule has uncommitted changes. Commit, stash, or clean them inside oms/${repo.alias} before pulling.`,
    );
    return "failed";
  }
  log.step(`${repo.alias}/${branch}: git pull --ff-only ${remote} ${branch}`);
  const r = runSub(repoRoot, repo.alias, ["pull", "--ff-only", remote, branch], true);
  if (!r.success) {
    log.error(`${repo.alias}/${branch}: pull from ${remote} failed (exit ${r.exitCode})`);
    return "failed";
  }
  log.success(`${repo.alias}/${branch}: pulled from ${remote}`);
  return "pulled";
}

function pushRepo(repo: Repo, repoRoot: string, remotes: string[], branch: string): OperationResult {
  if (isDirty(aliasDir(repoRoot, repo.alias))) {
    log.warn(`${repo.alias}: submodule has uncommitted changes; only the current HEAD will be pushed.`);
  }
  for (const remote of remotes) {
    // Only origin sets upstream — repointing @{u} to a fork would skew "oms status" ahead/behind.
    const args = remote === "origin" ? ["push", "-u", "origin", branch] : ["push", remote, branch];
    log.step(`${repo.alias}/${branch}: git ${args.join(" ")}`);
    const r = runSub(repoRoot, repo.alias, args, true);
    if (!r.success) {
      log.error(`${repo.alias}/${branch}: push to ${remote} failed (exit ${r.exitCode})`);
      return "failed";
    }
  }
  log.success(`${repo.alias}/${branch}: pushed to ${remotes.join(", ")}`);
  return "pushed";
}

export async function runManage(
  command: ManageCommand,
  aliases: string[],
  options: SourcesOptions & RemoteOptions,
): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;
  if (refuseInsideManagedTree(repoRoot)) return 1;


  const picked = await selectRepos(repos, aliases, options, command);
  if (!picked || picked.length === 0) return 1;

  const prepared = await prepareAliases(repoRoot, picked, {
    command,
    topologyOffer: command !== "push",
    explicitSelection: aliases.length > 0,
  });
  if (prepared.cancelled) return 1;

  const outcomes = new Map<string, OperationResult>();
  const ready = picked.filter((repo) => prepared.outcomes.get(repo.alias) === "ready");
  for (const [alias, outcome] of prepared.outcomes) {
    if (outcome !== "ready") outcomes.set(alias, outcome);
  }
  for (const repo of ready) {
    const remotes = await resolveRemotes(repo, options.remote, command);
    if (!remotes || remotes.length === 0) {
      outcomes.set(repo.alias, "failed");
      continue;
    }
    if (command === "fetch") {
      outcomes.set(repo.alias, fetchRepo(repo, repoRoot, remotes));
      continue;
    }
    const attached = await resolveDetachedHead(repoRoot, repo, command);
    if (!attached.ok) {
      outcomes.set(repo.alias, "failed");
      continue;
    }
    const branch = currentBranch(aliasDir(repoRoot, repo.alias))!;
    if (command === "pull") outcomes.set(repo.alias, pullRepo(repo, repoRoot, remotes[0], branch));
    else outcomes.set(repo.alias, pushRepo(repo, repoRoot, remotes, branch));
  }
  if (command !== "fetch") printRootFollowups(repoRoot, ready.map((r) => r.alias));
  const results = picked.map((repo) => outcomes.get(repo.alias)!);
  if (results.length > 1 || options.all) printSummary(results);
  return exitFromResults(results);
}
