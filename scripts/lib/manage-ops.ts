import { log } from "@clack/prompts";
import { existsSync } from "node:fs";
import { aliasDir, currentBranch, isDirty, runGit, runSub, submoduleInitialized } from "./git.js";
import { loadForSubmodules, loadRepos } from "./manifest.js";
import { exitFromResults, printSummary } from "./operation-results.js";
import { resolveRemotes, selectRepos } from "./prompts.js";
import { printRootFollowup } from "./status.js";
import type { ManageCommand, OperationResult, PushOptions, RemoteOptions, Repo, SourcesOptions } from "./types.js";
import { commonRepoPath, parseAlias } from "./worktree-paths.js";
import {
  fetchWorktreeRemotes,
  reconcileWorktreeRemotes,
  recordFetchProvenance,
} from "./worktree-sync.js";
import { NetworkSafetyError, networkFailure, runNetworkGit } from "./network-git.js";
import { listManagedWorktreeTargets, resolveWorktreeTarget, type ResolvedWorktreeTarget } from "./worktree-target.js";

function trackingRemote(tracking: string | null): string | null {
  if (!tracking) return null;
  const separator = tracking.indexOf("/");
  return separator > 0 ? tracking.slice(0, separator) : null;
}

function configuredBranchRemote(path: string, branch: string): string | null {
  const configured = runGit(path, ["config", "--get", `branch.${branch}.remote`]);
  const remote = configured.success ? configured.stdout.trim() : "";
  return remote && remote !== "." ? remote : null;
}

function aggregateCodes(results: number[]): number {
  return results.includes(2) ? 2 : results.includes(1) ? 1 : 0;
}

function pullWorktreeTarget(workspaceRoot: string, selected: ResolvedWorktreeTarget, remoteOption: string[]): number {
  const { repo, entry, state, target } = selected;
  const label = `${target.alias}/${target.name}`;
  const branch = state.branch as string;
  if (remoteOption.length > 1) {
    log.error(`${label}: pull accepts only one --remote value`);
    return 1;
  }
  const upstreamRemote = trackingRemote(state.trackingBranch) ?? configuredBranchRemote(entry.path, branch);
  const remote = remoteOption[0] ?? upstreamRemote ?? "origin";
  if (!(remote in repo.remotes)) {
    log.error(`${label}: upstream remote "${remote}" is not declared in oms.yaml; pass an explicit declared --remote`);
    return 1;
  }
  const common = commonRepoPath(workspaceRoot, repo.alias);
  try {
    reconcileWorktreeRemotes(workspaceRoot, common, repo);
    const fetched = runNetworkGit(
      common,
      repo,
      remote,
      (endpoint) => ["fetch", "--atomic", "--prune", endpoint, `+refs/heads/*:refs/remotes/${remote}/*`],
      {
        inheritOutput: true,
        onSuccess: () => recordFetchProvenance(workspaceRoot, repo, remote),
      },
    );
    if (!fetched.success) {
      log.error(`${label}: pull fetch from ${remote} failed`);
      return 2;
    }
  } catch (error) {
    networkFailure(repo, remote, error);
    return error instanceof NetworkSafetyError ? 1 : 2;
  }
  const remoteRef = `refs/remotes/${remote}/${branch}`;
  if (!runGit(common, ["rev-parse", "--verify", `${remoteRef}^{commit}`]).success) {
    log.error(`${label}: branch ${branch} is unavailable on declared remote ${remote}`);
    return 1;
  }
  if (!runGit(entry.path, ["merge", "--ff-only", remoteRef], true).success) {
    log.error(`${label}: fast-forward pull from ${remote}/${branch} failed`);
    return 2;
  }
  log.success(`${label}: pulled from ${remote}/${branch}`);
  return 0;
}

function pushWorktreeTarget(workspaceRoot: string, selected: ResolvedWorktreeTarget, remoteOption: string[]): number {
  const { repo, entry, state, target } = selected;
  const label = `${target.alias}/${target.name}`;
  const branch = state.branch as string;
  const upstreamRemote = trackingRemote(state.trackingBranch) ?? configuredBranchRemote(entry.path, branch);
  if (remoteOption.length === 0 && upstreamRemote && !(upstreamRemote in repo.remotes)) {
    log.error(`${label}: upstream remote "${upstreamRemote}" is not declared in oms.yaml; pass an explicit declared --remote`);
    return 1;
  }
  const remotes = remoteOption.length > 0 ? remoteOption : [upstreamRemote ?? "origin"];
  const unknown = remotes.find((remote) => !(remote in repo.remotes));
  if (unknown) {
    log.error(`${label}: remote "${unknown}" is not declared in oms.yaml`);
    return 1;
  }
  const common = commonRepoPath(workspaceRoot, repo.alias);
  try {
    reconcileWorktreeRemotes(workspaceRoot, common, repo);
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (state.dirty) log.warn(`${label}: worktree has uncommitted changes; only HEAD will be pushed`);
  let operationalFailure = false;
  let safetyFailure = false;
  for (const remote of remotes) {
    try {
      const pushed = runNetworkGit(
        common,
        repo,
        remote,
        (endpoint) => ["push", endpoint, `${branch}:refs/heads/${branch}`],
        { push: true, inheritOutput: true },
      );
      if (!pushed.success) {
        log.error(`${label}: push to ${remote} failed`);
        operationalFailure = true;
        continue;
      }
      log.success(`${label}: pushed to ${remote}/${branch}`);
      if (!state.trackingBranch && remote === "origin") {
        if (!runGit(common, ["config", `branch.${branch}.remote`, "origin"]).success
          || !runGit(common, ["config", `branch.${branch}.merge`, `refs/heads/${branch}`]).success) {
          log.error(`${label}: push succeeded but upstream configuration failed`);
          operationalFailure = true;
        }
      }
    } catch (error) {
      networkFailure(repo, remote, error);
      if (error instanceof NetworkSafetyError) safetyFailure = true;
      else operationalFailure = true;
    }
  }
  return operationalFailure ? 2 : safetyFailure ? 1 : 0;
}

async function runWorktreePullOrPush(
  command: "pull" | "push",
  repos: Repo[],
  workspaceRoot: string,
  targets: string[],
  options: SourcesOptions & RemoteOptions,
): Promise<number> {
  let requested = targets;
  if (command === "pull" && options.all) {
    try {
      requested = listManagedWorktreeTargets(workspaceRoot, repos);
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  if (requested.length === 0) requested = [""];
  const results: number[] = [];
  for (const value of requested) {
    const selected = await resolveWorktreeTarget(workspaceRoot, repos, value || undefined, command);
    if (!selected) {
      results.push(1);
      continue;
    }
    results.push(command === "pull"
      ? pullWorktreeTarget(workspaceRoot, selected, options.remote ?? [])
      : pushWorktreeTarget(workspaceRoot, selected, options.remote ?? []));
  }
  return aggregateCodes(results);
}

async function runWorktreeFetch(
  repos: Repo[],
  workspaceRoot: string,
  aliases: string[],
  options: SourcesOptions & RemoteOptions,
): Promise<number> {
  const picked = await selectRepos(repos, aliases, options, "fetch");
  if (!picked || picked.length === 0) return 1;
  const results: number[] = [];
  for (const repo of picked) {
    try {
      parseAlias(repo.alias);
      const selected = options.remote && options.remote.length > 0 ? options.remote : Object.keys(repo.remotes);
      const unknown = selected.find((remote) => !(remote in repo.remotes));
      if (unknown) {
        log.error(`${repo.alias}: remote "${unknown}" is not declared in oms.yaml`);
        results.push(1);
        continue;
      }
      const common = commonRepoPath(workspaceRoot, repo.alias);
      if (!existsSync(common)) {
        log.error(`${repo.alias}: common repository is missing; run "oms sync ${repo.alias}" first`);
        results.push(1);
        continue;
      }
      reconcileWorktreeRemotes(workspaceRoot, common, repo);
      results.push(fetchWorktreeRemotes(workspaceRoot, common, repo, selected).code);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(message);
      results.push(/additional fetch URLs|pushurl|symbolic link|outside the workspace/.test(message) ? 1 : 2);
    }
  }
  return results.includes(2) ? 2 : results.includes(1) ? 1 : 0;
}

function fetchRepo(repo: Repo, repoRoot: string, remotes: string[]): OperationResult {
  if (!submoduleInitialized(repoRoot, repo.alias)) {
    log.error(`${repo.alias}: not synced. Run "oms sync ${repo.alias}" first.`);
    return "failed";
  }
  for (const remote of remotes) {
    log.step(`${repo.alias}: git fetch ${remote} --prune`);
    const r = runSub(repoRoot, repo.alias, ["fetch", remote, "--prune"], true);
    if (!r.success) {
      log.error(`${repo.alias}: fetch ${remote} failed (exit ${r.exitCode})`);
      return "failed";
    }
  }
  log.success(`${repo.alias}: fetched (${remotes.join(", ")})`);
  return "fetched";
}

function pullRepo(repo: Repo, repoRoot: string, remote: string): OperationResult {
  if (!submoduleInitialized(repoRoot, repo.alias)) {
    log.error(`${repo.alias}: not synced. Run "oms sync ${repo.alias}" first.`);
    return "failed";
  }
  const branch = currentBranch(aliasDir(repoRoot, repo.alias));
  if (!branch) {
    log.error(
      `${repo.alias}: detached HEAD. Run "oms branch switch ${repo.alias} <branch>" before pulling.`,
    );
    return "failed";
  }
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
  // Pull synchronizes only the submodule branch; the root gitlink is never staged or committed.
  log.success(`${repo.alias}/${branch}: pulled from ${remote}`);
  printRootFollowup(repoRoot, repo.alias);
  return "pulled";
}

function pushRepo(repo: Repo, repoRoot: string, remotes: string[]): OperationResult {
  if (!submoduleInitialized(repoRoot, repo.alias)) {
    log.error(`${repo.alias}: not synced. Run "oms sync ${repo.alias}" first.`);
    return "failed";
  }
  const branch = currentBranch(aliasDir(repoRoot, repo.alias));
  if (!branch) {
    log.error(
      `${repo.alias}: detached HEAD. Run "oms branch switch ${repo.alias} <branch>" before pushing.`,
    );
    return "failed";
  }
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
  // Push synchronizes only the submodule branch; the root gitlink is never staged or committed.
  log.success(`${repo.alias}/${branch}: pushed to ${remotes.join(", ")}`);
  printRootFollowup(repoRoot, repo.alias);
  return "pushed";
}

export async function runManage(
  command: ManageCommand,
  aliases: string[],
  options: SourcesOptions & PushOptions & RemoteOptions,
): Promise<number> {
  const mode = loadRepos();
  if (mode?.mode === "worktree" && command === "fetch") {
    return runWorktreeFetch(mode.repos, mode.repoRoot, aliases, options);
  }
  if (mode?.mode === "worktree" && (command === "pull" || command === "push")) {
    return runWorktreePullOrPush(command, mode.repos, mode.repoRoot, aliases, options);
  }
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  // Reject the removed push pointer shortcuts before any push runs, with migration guidance.
  if (command === "push" && (options.commit || options.record)) {
    const flag = options.record ? "--record" : "--commit";
    const pushExample = aliases.length > 0 ? `oms push ${aliases.join(" ")}` : "oms push <alias>";
    const recordExample = aliases.length > 0 ? `oms record ${aliases[0]}` : "oms record <alias>";
    log.error(
      `"oms push ${flag}" is not supported. Push the submodule branch with "${pushExample}", then commit the existing root pointer update with "${recordExample}".`,
    );
    return 1;
  }

  const picked = await selectRepos(repos, aliases, options, command);
  if (!picked || picked.length === 0) return 1;

  // Each alias is processed independently; a per-alias failure does not stop later aliases.
  const results: OperationResult[] = [];
  for (const repo of picked) {
    const remotes = await resolveRemotes(repo, options.remote, command);
    if (!remotes || remotes.length === 0) {
      results.push("failed");
      continue;
    }
    if (command === "fetch") results.push(fetchRepo(repo, repoRoot, remotes));
    else if (command === "pull") results.push(pullRepo(repo, repoRoot, remotes[0]));
    else results.push(pushRepo(repo, repoRoot, remotes));
  }
  if (results.length > 1 || options.all) printSummary(results);
  return exitFromResults(results);
}
