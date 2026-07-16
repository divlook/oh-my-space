import { log } from "@clack/prompts";
import { aliasDir, currentBranch, isDirty, runSub, submoduleInitialized } from "./git.js";
import { loadForSubmodules } from "./manifest.js";
import { exitFromResults, printSummary } from "./operation-results.js";
import { resolveRemotes, selectRepos } from "./prompts.js";
import { printRootFollowup } from "./status.js";
import type { ManageCommand, OperationResult, PushOptions, RemoteOptions, Repo, SourcesOptions } from "./types.js";

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
