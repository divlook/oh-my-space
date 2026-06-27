import { existsSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { DATA_DIRNAME } from "./constants.js";
import { finalizeTopology } from "./commit.js";
import {
  aliasDir,
  currentBranch,
  hasRegisteredSubmodules,
  isDirty,
  isGitRepo,
  isRegisteredSubmodule,
  listLocalBranches,
  listRemoteBranches,
  localBranchExists,
  remoteBranchExists,
  runGit,
  runSub,
  submoduleInitialized,
  submodulePath,
} from "./git.js";
import {
  abortOnLegacyRenameAt,
  abortOnLegacyWorktree,
  attachBranch,
  emitLegacyRenameHintWalkUp,
  ensureOmsNotIgnored,
  ensureRemotes,
  gitmodulesBranch,
  loadForSubmodules,
  loadRepos,
} from "./manifest.js";
import {
  pickBranch,
  printList,
  resolveInitializedAlias,
  resolveRemotes,
  selectRepos,
} from "./prompts.js";
import {
  assertRootTopologySafe,
  gitOperationInProgress,
  gitlinkState,
  partialRemovalTopology,
  pendingRemovalTopology,
  printRootFollowup,
  readAliasDirEntries,
} from "./status.js";
import type {
  CheckoutOptions,
  ManageCommand,
  OperationResult,
  PushOptions,
  RemoteOptions,
  RemoveOutcome,
  Repo,
  SourcesOptions,
  SyncCommitOptions,
  UnsyncOptions,
} from "./types.js";

function cleanupFailedAdd(repoRoot: string, alias: string): void {
  const path = submodulePath(alias);
  runGit(repoRoot, ["submodule", "deinit", "-f", "--", path]);
  runGit(repoRoot, ["rm", "-f", "--cached", "--", path]);
  runGit(repoRoot, ["config", "--file", ".gitmodules", "--remove-section", `submodule.${path}`]);
  if (existsSync(join(repoRoot, ".gitmodules"))) runGit(repoRoot, ["add", ".gitmodules"]);
  try {
    rmSync(join(repoRoot, ".git", "modules", DATA_DIRNAME, alias), { recursive: true, force: true });
  } catch {}
  try {
    if (existsSync(aliasDir(repoRoot, alias))) rmSync(aliasDir(repoRoot, alias), { recursive: true, force: true });
  } catch {}
}

function headGitmodulesSection(repoRoot: string, alias: string): string | null {
  const path = submodulePath(alias);
  const r = runGit(repoRoot, ["show", "HEAD:.gitmodules"]);
  if (!r.success) return null;
  const lines = r.stdout.split("\n");
  const start = lines.findIndex((line) => line.trim() === `[submodule "${path}"]`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[submodule ".+"\]\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return `${lines.slice(start, end).join("\n").replace(/\n*$/, "\n")}`;
}

function headFollowingGitmodulesHeaders(repoRoot: string, alias: string): string[] {
  const path = submodulePath(alias);
  const r = runGit(repoRoot, ["show", "HEAD:.gitmodules"]);
  if (!r.success) return [];
  const lines = r.stdout.split("\n");
  const start = lines.findIndex((line) => line.trim() === `[submodule "${path}"]`);
  if (start === -1) return [];
  const headers: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const match = lines[i].trim().match(/^\[submodule "(.+)"\]$/);
    if (match) headers.push(`[submodule "${match[1]}"]`);
  }
  return headers;
}

function currentGitmodulesHasSameAliasSection(repoRoot: string, alias: string): boolean {
  const gitmodules = join(repoRoot, ".gitmodules");
  if (!existsSync(gitmodules)) return false;
  return readFileSync(gitmodules, "utf8").split("\n").some((line) => line.trim() === `[submodule "${submodulePath(alias)}"]`);
}

function insertGitmodulesSection(repoRoot: string, alias: string, section: string): void {
  const gitmodules = join(repoRoot, ".gitmodules");
  const existing = existsSync(gitmodules) ? readFileSync(gitmodules, "utf8") : "";
  const followingHeaders = headFollowingGitmodulesHeaders(repoRoot, alias);
  const lines = existing.split("\n");
  for (const followingHeader of followingHeaders) {
    const insertAt = lines.findIndex((line) => line.trim() === followingHeader);
    if (insertAt !== -1) {
      lines.splice(insertAt, 0, ...section.replace(/\n$/, "").split("\n"));
      writeFileSync(gitmodules, lines.join("\n"));
      return;
    }
  }
  const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  writeFileSync(gitmodules, `${existing}${separator}${section}`);
}

function gitmoduleValue(repoRoot: string, alias: string, key: "url" | "branch"): string | null {
  const r = runGit(repoRoot, ["config", "--file", ".gitmodules", "--get", `submodule.${submodulePath(alias)}.${key}`]);
  const value = r.stdout.trim();
  return r.success && value.length > 0 ? value : null;
}

function reconcileGitmodulesMetadata(repoRoot: string, repo: Repo): boolean {
  const path = submodulePath(repo.alias);
  let changed = false;
  if (gitmoduleValue(repoRoot, repo.alias, "url") !== repo.remotes.origin) {
    runGit(repoRoot, ["config", "--file", ".gitmodules", `submodule.${path}.url`, repo.remotes.origin]);
    changed = true;
  }
  const currentBranchValue = gitmoduleValue(repoRoot, repo.alias, "branch");
  if (repo.branch) {
    if (currentBranchValue !== repo.branch) {
      runGit(repoRoot, ["config", "--file", ".gitmodules", `submodule.${path}.branch`, repo.branch]);
      changed = true;
    }
  } else if (currentBranchValue !== null) {
    runGit(repoRoot, ["config", "--file", ".gitmodules", "--unset", `submodule.${path}.branch`]);
    changed = true;
  }
  return changed;
}

function cleanupRestorableAliasDir(repoRoot: string, alias: string): boolean {
  if (submoduleInitialized(repoRoot, alias)) return true;
  const dirState = readAliasDirEntries(repoRoot, alias);
  if (!dirState.exists) return true;
  if (dirState.entries === null) return false;
  const entries = dirState.entries;
  if (entries.length > 0 && entries.some((entry) => entry !== ".DS_Store")) return false;
  try {
    rmSync(aliasDir(repoRoot, alias), { recursive: true, force: true });
  } catch {
    return false;
  }
  return true;
}

function restorePendingRemoval(repo: Repo, repoRoot: string): { result: OperationResult; restored: boolean } {
  const alias = repo.alias;
  const path = submodulePath(alias);
  const state = gitlinkState(repoRoot, alias);
  const shouldRestore = state.headOid !== null && (pendingRemovalTopology(state) || partialRemovalTopology(state));
  if (!shouldRestore) return { result: "failed", restored: false };

  const unsafe = (detail: string): { result: OperationResult; restored: boolean } => {
    log.error(`${alias}: cannot restore pending removal safely (${detail}). Resolve or commit the pending removal before syncing.`);
    return { result: "failed", restored: true };
  };

  if (state.conflict) return unsafe("root gitlink is conflicted");
  const rootOp = gitOperationInProgress(repoRoot);
  if (rootOp) return unsafe(`root repository has a ${rootOp} in progress`);
  if (currentGitmodulesHasSameAliasSection(repoRoot, alias) && !state.gitmodulesEntry) {
    return unsafe("current .gitmodules has an incomplete same-alias section");
  }
  const section = headGitmodulesSection(repoRoot, alias);
  if (!section) return unsafe(".gitmodules metadata is not recoverable from HEAD");
  if (!cleanupRestorableAliasDir(repoRoot, alias)) {
    return unsafe(`${path} is occupied by a non-submodule path`);
  }

  runGit(repoRoot, ["restore", "--source=HEAD", "--staged", "--", ".gitmodules"]);
  if (!state.gitmodulesEntry) insertGitmodulesSection(repoRoot, alias, section);
  const metadataUpdated = reconcileGitmodulesMetadata(repoRoot, repo);

  const restorePath = runGit(repoRoot, ["restore", "--source=HEAD", "--staged", "--worktree", "--", path], true);
  if (!restorePath.success) return unsafe(`failed to restore ${path} from HEAD`);
  runGit(repoRoot, ["submodule", "sync", "--", path]);

  log.step(`${alias}: git submodule update --init ${path}`);
  const upd = runGit(repoRoot, ["submodule", "update", "--init", "--", path], true);
  if (!upd.success) {
    log.error(`${alias}: git submodule update --init failed (exit ${upd.exitCode})`);
    return { result: "failed", restored: true };
  }
  ensureRemotes(repoRoot, alias, repo.remotes);
  const branch = gitmodulesBranch(repoRoot, alias) ?? repo.branch;
  if (branch) attachBranch(repoRoot, alias, branch);
  log.success(`${alias}: restored pending removal${metadataUpdated ? " and updated .gitmodules metadata" : ""}`);
  return { result: "added", restored: true };
}

function syncRepo(repo: Repo, repoRoot: string): OperationResult {
  const alias = repo.alias;
  const path = submodulePath(alias);
  const registered = isRegisteredSubmodule(repoRoot, path);
  const state = gitlinkState(repoRoot, alias);

  if (!registered && state.headOid !== null) {
    const restore = restorePendingRemoval(repo, repoRoot);
    if (restore.restored) return restore.result;
  }

  if (!registered) {
    const dirState = readAliasDirEntries(repoRoot, alias);
    if (dirState.exists && (dirState.entries === null || dirState.entries.length > 0)) {
      log.error(
        `${alias}: ${path}/ already exists but is not a registered submodule. Move or remove it manually, then retry.`,
      );
      return "failed";
    }

    if (repo.branch) {
      const lsRemote = runGit(repoRoot, [
        "ls-remote",
        "--exit-code",
        "--heads",
        repo.remotes.origin,
        repo.branch,
      ]);
      if (lsRemote.exitCode === 2) {
        log.error(
          `${alias}: branch "${repo.branch}" not found on ${repo.remotes.origin}. Push the branch upstream or fix the alias, then retry.`,
        );
        return "failed";
      }
      if (!lsRemote.success && lsRemote.exitCode !== 2) {
        log.warn(`${alias}: branch existence check failed (exit ${lsRemote.exitCode}); proceeding.`);
      }
    }

    // `git submodule add` refuses when .gitmodules is tracked in HEAD but missing from the
    // working tree — the state left by an uncommitted unsync. Restore an empty one so it can append.
    const gitmodules = join(repoRoot, ".gitmodules");
    if (!existsSync(gitmodules) && runGit(repoRoot, ["cat-file", "-e", "HEAD:.gitmodules"]).success) {
      writeFileSync(gitmodules, "");
    }

    log.step(`${alias}: git submodule add${repo.branch ? ` -b ${repo.branch}` : ""} ${repo.remotes.origin} ${path}`);
    const args = ["submodule", "add", ...(repo.branch ? ["-b", repo.branch] : []), "--", repo.remotes.origin, path];
    const add = runGit(repoRoot, args, true);
    if (!add.success) {
      log.error(`${alias}: git submodule add failed (exit ${add.exitCode})`);
      cleanupFailedAdd(repoRoot, alias);
      return "failed";
    }
    ensureRemotes(repoRoot, alias, repo.remotes);
    const branch = repo.branch ?? currentBranch(aliasDir(repoRoot, alias));
    if (branch) attachBranch(repoRoot, alias, branch);
    log.success(`${alias}: added${branch ? ` (branch=${branch})` : ""}`);
    return "added";
  }

  if (!submoduleInitialized(repoRoot, alias)) {
    log.step(`${alias}: git submodule update --init ${path}`);
    const upd = runGit(repoRoot, ["submodule", "update", "--init", "--", path], true);
    if (!upd.success) {
      log.error(`${alias}: git submodule update --init failed (exit ${upd.exitCode})`);
      return "failed";
    }
    ensureRemotes(repoRoot, alias, repo.remotes);
    const branch = gitmodulesBranch(repoRoot, alias) ?? repo.branch;
    if (branch) attachBranch(repoRoot, alias, branch);
    log.success(`${alias}: initialized${branch ? ` (branch=${branch})` : ""}`);
    return "added";
  }

  ensureRemotes(repoRoot, alias, repo.remotes);
  log.step(`${alias}: git fetch origin --prune`);
  const fetch = runSub(repoRoot, alias, ["fetch", "origin", "--prune"], true);
  if (!fetch.success) {
    log.error(`${alias}: fetch failed (exit ${fetch.exitCode})`);
    return "failed";
  }
  const branch = gitmodulesBranch(repoRoot, alias) ?? repo.branch;
  if (branch) attachBranch(repoRoot, alias, branch);
  log.success(`${alias}: updated`);
  return "updated";
}

function unsyncRepo(repo: Repo, repoRoot: string, force: boolean): RemoveOutcome {
  const alias = repo.alias;
  const path = submodulePath(alias);
  const registered = isRegisteredSubmodule(repoRoot, path);
  const exists = existsSync(aliasDir(repoRoot, alias));

  if (!registered && !exists) return "nothing-to-remove";

  // Refuse before any deinit/rm/rmSync when the root topology cannot be mutated safely. The
  // occupied-path check guards the unregistered-but-occupied case that previously fell through to a
  // destructive rmSync, deleting a non-submodule path while falsely reporting success.
  const safety = assertRootTopologySafe(repoRoot, alias);
  if (!safety.safe) {
    log.error(`${alias}: ${safety.reason}`);
    return "failed";
  }

  if (!force && submoduleInitialized(repoRoot, alias) && isDirty(aliasDir(repoRoot, alias))) {
    log.error(
      `${alias}: ${path} has uncommitted or untracked changes. Commit, stash, remove them, or pass --force.`,
    );
    return "failed";
  }

  runGit(repoRoot, ["submodule", "deinit", ...(force ? ["-f"] : []), "--", path]);
  const rm = runGit(repoRoot, ["rm", "-f", "--", path], true);
  if (!rm.success) {
    // git rm couldn't stage the removal (e.g. the submodule was never initialized).
    runGit(repoRoot, ["rm", "-f", "--cached", "--", path]);
  }
  // Always strip the registration explicitly: git rm's implicit .gitmodules edit is unreliable
  // across git versions/states, and when it silently no-ops the section is orphaned for good.
  // A missing section just makes these exit non-zero — harmless, output stays captured.
  runGit(repoRoot, ["config", "--file", ".gitmodules", "--remove-section", `submodule.${path}`]);
  if (existsSync(join(repoRoot, ".gitmodules"))) runGit(repoRoot, ["add", ".gitmodules"]);
  // Drop the matching .git/config section too, in case deinit was skipped or failed.
  runGit(repoRoot, ["config", "--remove-section", `submodule.${path}`]);
  try {
    rmSync(join(repoRoot, ".git", "modules", DATA_DIRNAME, alias), { recursive: true, force: true });
  } catch {}
  // Drop the now-empty .git/modules/oms/ container so no stale gitdir scaffolding lingers.
  try {
    const modulesParent = join(repoRoot, ".git", "modules", DATA_DIRNAME);
    if (existsSync(modulesParent) && readdirSync(modulesParent).length === 0) rmdirSync(modulesParent);
  } catch {}
  if (existsSync(aliasDir(repoRoot, alias))) {
    rmSync(aliasDir(repoRoot, alias), { recursive: true, force: true });
  }
  // Drop the now-empty oms/ directory if nothing else lives there.
  try {
    const parent = join(repoRoot, DATA_DIRNAME);
    if (existsSync(parent) && readdirSync(parent).length === 0) rmdirSync(parent);
  } catch {}

  // Drop .gitmodules once it no longer registers any submodule (judged by content, not byte-emptiness).
  const gitmodules = join(repoRoot, ".gitmodules");
  if (existsSync(gitmodules) && !hasRegisteredSubmodules(repoRoot)) {
    if (!runGit(repoRoot, ["rm", "-f", "--", ".gitmodules"]).success) {
      rmSync(gitmodules, { force: true });
    }
  }

  return "removed";
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
      `${repo.alias}: detached HEAD. Run "oms switch ${repo.alias} <branch>" before pulling.`,
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
      `${repo.alias}: detached HEAD. Run "oms switch ${repo.alias} <branch>" before pushing.`,
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

function printSummary(results: OperationResult[]): void {
  const counts: Record<OperationResult, number> = {
    added: 0,
    updated: 0,
    fetched: 0,
    pulled: 0,
    pushed: 0,
    unsynced: 0,
    failed: 0,
  };
  for (const r of results) counts[r]++;

  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name} ${count}`);
  log.message(`Summary: ${parts.join(", ")}`);
}

function exitFromResults(results: OperationResult[]): number {
  return results.includes("failed") ? 2 : 0;
}

export async function runSync(aliases: string[], options: SyncCommitOptions): Promise<number> {
  const loaded = loadRepos();
  if (!loaded) {
    emitLegacyRenameHintWalkUp();
    return 1;
  }
  const { repos, repoRoot } = loaded;
  if (abortOnLegacyRenameAt(repoRoot)) return 1;

  if (options.list) {
    printList(repos);
    return 0;
  }

  if (!isGitRepo(repoRoot)) {
    log.error(
      `${repoRoot} is not a git repository. oh-my-space 0.6.0 manages sources as git submodules; run "git init" at the workspace root first.`,
    );
    return 1;
  }
  if (abortOnLegacyWorktree(repoRoot, repos)) return 1;

  const picked = await selectRepos(repos, aliases, options, "sync");
  if (!picked || picked.length === 0) return 1;

  ensureOmsNotIgnored(repoRoot);

  const results = picked.map((repo) => syncRepo(repo, repoRoot));
  const topoExit = await finalizeTopology(
    repoRoot,
    picked.map((r) => r.alias),
    "add",
    options.commit ?? false,
    !results.includes("failed"),
  );
  if (results.length > 1 || options.all) printSummary(results);
  return exitFromResults(results) || topoExit;
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

export async function runUnsync(aliases: string[], options: UnsyncOptions): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  const picked = await selectRepos(repos, aliases, options, "unsync");
  if (!picked || picked.length === 0) return 1;

  const results: OperationResult[] = picked.map((repo) => {
    log.step(`${repo.alias}: unsync`);
    const outcome = unsyncRepo(repo, repoRoot, options.force ?? false);
    if (outcome === "removed") {
      log.success(`${repo.alias}: unsynced`);
      return "unsynced";
    }
    if (outcome === "nothing-to-remove") {
      log.info(`${repo.alias}: nothing to remove`);
      return "unsynced";
    }
    return "failed";
  });

  const topoExit = await finalizeTopology(
    repoRoot,
    picked.map((r) => r.alias),
    "remove",
    options.commit ?? false,
    !results.includes("failed"),
  );

  if (results.length > 1 || options.all) printSummary(results);
  // Name the failed aliases so a buried failure among several isn't read as "all unsynced". The
  // specific cause was already logged per alias by unsyncRepo (dirty tree, conflict, in-progress
  // root op, or occupied path), so the aggregate must not assert a single contradictory cause.
  const failed = picked.filter((_, i) => results[i] === "failed").map((r) => r.alias);
  if (failed.length > 0) {
    log.error(`Not unsynced: ${failed.join(", ")}. See the per-alias error above for each.`);
  }
  return exitFromResults(results) || topoExit;
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
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  const repo = await resolveInitializedAlias(repos, repoRoot, alias, "switch");
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

  // Brand-new local branch: no remote precondition, no upstream tracking (use "oms checkout" for that).
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
 * them interactively. Creating brand-new local branches is "oms switch"'s job.
 */
export async function runCheckout(alias: string | undefined, branch: string | undefined): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  const repo = await resolveInitializedAlias(repos, repoRoot, alias, "checkout");
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
    `${repo.alias}: "${target}" not found on origin. To create a new local branch, run "oms switch ${repo.alias} ${target}".`,
  );
  return 1;
}
