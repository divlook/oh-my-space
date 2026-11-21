import { log } from "@clack/prompts";
import { aliasDir, isDirty, redactingGitRunner, runSub } from "./git.js";
import { exitFromResults, printSummary } from "./operation-results.js";
import { resolveRemotes, selectRepos } from "./prompts.js";
import type { ManageCommand, OperationResult, RemoteOptions, Repo, SourcesOptions } from "./types.js";
import { refuseInsideManagedTree } from "./tree-context.js";
import { resolveSourceBranch } from "./source-attachment.js";
import { ensureSourceRemotes } from "./source-remotes.js";
import { prepareSources, requireSource } from "./source-preparation.js";
import { loadForSources } from "./source-workspace.js";
import { uniqueAliases } from "./env.js";

function fetchRepo(repo: Repo, repoRoot: string, remotes: string[]): OperationResult {
  for (const remote of remotes) {
    log.step(`${repo.alias}: git fetch ${remote} --prune`);
    let r = runSub(repoRoot, repo.alias, ["fetch", remote, "--prune"], true, redactingGitRunner);
    if (!r.success) r = runSub(repoRoot, repo.alias, ["fetch", remote, "--prune"], true, redactingGitRunner);
    if (!r.success) {
      log.error(`${repo.alias}: fetch ${remote} failed (exit ${r.exitCode})`);
      return "failed";
    }
  }
  log.success(`${repo.alias}: fetched (${remotes.join(", ")})`);
  return "fetched";
}

function pullRepo(repo: Repo, repoRoot: string, remote: string, branch: string): OperationResult {
  const status = runSub(repoRoot, repo.alias, ["--no-optional-locks", "status", "--porcelain"]);
  if (!status.success) {
    log.error(`${repo.alias}: could not confirm the source is clean. Check its Git status before pulling.`);
    return "failed";
  }
  if (status.stdout.trim()) {
    log.error(
      `${repo.alias}: source has uncommitted changes. Commit, stash, or clean them inside oms/${repo.alias} before pulling.`,
    );
    return "failed";
  }
  log.step(`${repo.alias}/${branch}: git pull --ff-only ${remote} ${branch}`);
  const ref = `refs/heads/${branch}`;
  // Git also tries abbreviated ref names when an exact source is absent. Exclude those fallbacks.
  const r = runSub(repoRoot, repo.alias, [
    "pull", "--ff-only", remote, ref,
    `^refs/${ref}`, `^refs/tags/${ref}`, `^refs/heads/${ref}`,
    `^refs/remotes/${ref}`, `^refs/remotes/${ref}/HEAD`,
  ], true, redactingGitRunner);
  if (!r.success) {
    log.error(`${repo.alias}/${branch}: pull from ${remote} failed (exit ${r.exitCode})`);
    return "failed";
  }
  log.success(`${repo.alias}/${branch}: pulled from ${remote}`);
  return "pulled";
}

function pushRepo(repo: Repo, repoRoot: string, remotes: string[], branch: string): OperationResult {
  if (isDirty(aliasDir(repoRoot, repo.alias))) {
    log.warn(`${repo.alias}: source has uncommitted changes; only the current HEAD will be pushed.`);
  }
  const ref = `refs/heads/${branch}`;
  const listed = runSub(repoRoot, repo.alias, [
    "-c", "core.warnAmbiguousRefs=true", "for-each-ref",
    "--format=%(refname)%00%(refname:short)", ref,
  ]);
  const key = `${ref}\0`;
  const source = listed.stdout.slice(key.length).replace(/\r?\n$/, "");
  if (!listed.success || !listed.stdout.startsWith(key) || !source || /[\0\n]/.test(source)) {
    log.error(`${repo.alias}/${branch}: could not resolve the local branch to push.`);
    return "failed";
  }
  for (const remote of remotes) {
    const args = remote === "origin" ? ["push", "-u"] : ["push"];
    log.step(`${repo.alias}/${branch}: git ${args.join(" ")} ${source.startsWith("-") ? "-- " : ""}${remote} ${source}`);
    args.push("--", remote, source);
    const r = runSub(repoRoot, repo.alias, args, true, redactingGitRunner);
    if (!r.success) {
      log.error(`${repo.alias}/${branch}: push to ${remote} failed (exit ${r.exitCode})`);
      return "failed";
    }
  }
  log.success(`${repo.alias}/${branch}: pushed to ${remotes.join(", ")}`);
  return "pushed";
}

export async function runSourceManage(command: ManageCommand, aliases: string[], options: SourcesOptions & RemoteOptions): Promise<number> {
  const loaded = loadForSources();
  if (!loaded || refuseInsideManagedTree(loaded.repoRoot)) return 1;
  const { workspace, repoRoot, repos } = loaded;
  let picked: Repo[] | null;
  if (options.all) {
    picked = repos;
  } else if (aliases.length) {
    const byAlias = new Map(repos.map((repo) => [repo.alias, repo]));
    const names = uniqueAliases(aliases);
    const unknown = names.filter((alias) => !byAlias.has(alias));
    if (unknown.length) {
      log.error(`Unknown alias(es): ${unknown.join(", ")}. Use "oms clone --list" to see declared aliases.`);
      return 1;
    }
    picked = names.map((alias) => byAlias.get(alias)!);
  } else {
    picked = await selectRepos(repos, [], options, command);
  }
  if (!picked?.length) return 1;

  const outcomes = new Map<string, OperationResult>();
  const requested = new Map<string, string[]>();
  if (options.remote?.length) {
    for (const repo of picked) {
      const remotes = await resolveRemotes(repo, options.remote, command);
      if (remotes) requested.set(repo.alias, remotes);
      else outcomes.set(repo.alias, "failed");
    }
  }
  const selected = picked.filter((repo) => !outcomes.has(repo.alias));
  const missingPolicy = command === "push" ? "fail" : !options.all && aliases.length > 0 ? "offer-clone" : "offer-skip";
  const prepared = await prepareSources(workspace, selected, command, missingPolicy);
  if (!prepared) return 1;
  for (const repo of selected) {
    const outcome = prepared.get(repo.alias)!;
    if (outcome.kind !== "ready") {
      outcomes.set(repo.alias, outcome.kind === "skipped" ? "skipped" : "failed");
      continue;
    }
    const remotes = requested.get(repo.alias) ?? await resolveRemotes(repo, undefined, command);
    if (!remotes?.length) { outcomes.set(repo.alias, "failed"); continue; }
    const checkout = requireSource(workspace, repo);
    if (!checkout) { outcomes.set(repo.alias, "failed"); continue; }
    const attached = command === "fetch" ? null : await resolveSourceBranch(workspace, repo, checkout, command);
    if (attached && !attached.ok) { outcomes.set(repo.alias, "failed"); continue; }
    const configured = ensureSourceRemotes(repoRoot, repo.alias, repo.remotes, remotes);
    const failures = configured.filter((remote) => !remote.ok);
    if (failures.length) {
      for (const remote of failures) log.error(`${repo.alias}: could not configure remote ${remote.name}${remote.diagnostic ? `: ${remote.diagnostic}` : "."}`);
      outcomes.set(repo.alias, "failed");
      continue;
    }
    if (!attached) outcomes.set(repo.alias, fetchRepo(repo, repoRoot, remotes));
    else if (command === "pull") outcomes.set(repo.alias, pullRepo(repo, repoRoot, remotes[0], attached.branch));
    else outcomes.set(repo.alias, pushRepo(repo, repoRoot, remotes, attached.branch));
  }
  const results = picked.map((repo) => outcomes.get(repo.alias)!);
  if (results.length > 1 || options.all) printSummary(results);
  return exitFromResults(results);
}
