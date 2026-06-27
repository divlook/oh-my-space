import { existsSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { DATA_DIRNAME } from "./constants.js";
import {
  aliasDir,
  currentBranch,
  hasRegisteredSubmodules,
  isDirty,
  isGitRepo,
  isRegisteredSubmodule,
  runGit,
  runSub,
  submoduleInitialized,
  submodulePath,
} from "./git.js";
import {
  abortOnLegacyRenameAt,
  abortOnLegacyWorktree,
  emitLegacyRenameHintWalkUp,
  loadForSubmodules,
  loadRepos,
} from "./manifest.js";
import {
  printList,
  selectRepos,
} from "./prompts.js";
import { exitFromResults, printSummary } from "./operation-results.js";
import {
  assertRootTopologySafe,
  gitOperationInProgress,
  gitlinkState,
  partialRemovalTopology,
  pendingRemovalTopology,
  readAliasDirEntries,
  unreadablePathReason,
} from "./status.js";
import { finalizeTopology } from "./topology-commit.js";
import { attachBranch, ensureRemotes, gitmodulesBranch } from "./submodule-config.js";
import { ensureOmsNotIgnored } from "./workspace-ignore.js";
import type {
  OperationResult,
  RemoveOutcome,
  Repo,
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

/** Whether oms/<alias> can be cleared to restore a pending removal: cleaned/absent, or why not. */
type RestorableCleanup = "ok" | "occupied" | "unreadable" | "unremovable";

function cleanupRestorableAliasDir(repoRoot: string, alias: string): RestorableCleanup {
  if (submoduleInitialized(repoRoot, alias)) return "ok";
  const dirState = readAliasDirEntries(repoRoot, alias);
  if (!dirState.exists) return "ok";
  if (dirState.kind === "unreadable") return "unreadable";
  if (dirState.kind === "file") return "occupied";
  const entries = dirState.entries;
  if (entries.length > 0 && entries.some((entry) => entry !== ".DS_Store")) return "occupied";
  try {
    rmSync(aliasDir(repoRoot, alias), { recursive: true, force: true });
  } catch {
    // The directory was readable and empty, so a removal failure is a delete-time access/IO problem,
    // not occupancy; report it distinctly so the message does not falsely claim non-submodule content.
    return "unremovable";
  }
  return "ok";
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
  const cleanup = cleanupRestorableAliasDir(repoRoot, alias);
  if (cleanup === "unreadable") return unsafe(`${path} could not be read (permission or I/O error)`);
  if (cleanup === "unremovable") return unsafe(`${path} could not be removed (permission or I/O error)`);
  if (cleanup === "occupied") return unsafe(`${path} is occupied by a non-submodule path`);

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
    if (dirState.exists && dirState.kind === "unreadable") {
      log.error(`${alias}: ${unreadablePathReason(alias)}`);
      return "failed";
    }
    if (dirState.exists && (dirState.kind === "file" || dirState.entries.length > 0)) {
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
