import { existsSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { DATA_DIRNAME } from "./constants.js";
import {
  aliasDir,
  hasRegisteredSubmodules,
  isDirty,
  isRegisteredSubmodule,
  runGit,
  submoduleInitialized,
  submodulePath,
} from "./git.js";
import {
  abortOnLegacyRenameAt,
  abortOnLegacyWorktree,
  emitLegacyRenameHintWalkUp,
  emitWorkspaceGitIdentityError,
  loadForSubmodules,
  loadRepos,
} from "./manifest.js";
import {
  printList,
  selectRepos,
} from "./prompts.js";
import { exitFromResults, printSummary } from "./operation-results.js";
import { assertRootTopologySafe } from "./workspace-state.js";
import { finalizeTopology } from "./topology-commit.js";
import { listManagedTrees } from "./tree-inventory.js";
import type {
  OperationResult,
  RemoveOutcome,
  Repo,
  SyncCommitOptions,
  UnsyncOptions,
} from "./types.js";
import { syncWorkspace } from "./sync-workspace.js";
import { prepareTopologyMutation } from "./topology-preflight.js";


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
  runGit(repoRoot, ["config", "--remove-section", `submodule.${path}`]);
  try {
    rmSync(join(repoRoot, ".git", "modules", DATA_DIRNAME, alias), { recursive: true, force: true });
  } catch {}
  try {
    const modulesParent = join(repoRoot, ".git", "modules", DATA_DIRNAME);
    if (existsSync(modulesParent) && readdirSync(modulesParent).length === 0) rmdirSync(modulesParent);
  } catch {}
  if (existsSync(aliasDir(repoRoot, alias))) {
    rmSync(aliasDir(repoRoot, alias), { recursive: true, force: true });
  }
  try {
    const parent = join(repoRoot, DATA_DIRNAME);
    if (existsSync(parent) && readdirSync(parent).length === 0) rmdirSync(parent);
  } catch {}

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

  if (emitWorkspaceGitIdentityError(repoRoot)) return 1;
  if (abortOnLegacyWorktree(repoRoot, repos)) return 1;

  const picked = await selectRepos(repos, aliases, options, "sync");
  if (!picked || picked.length === 0) return 1;
  return syncWorkspace(repoRoot, picked, options);

}

export async function runUnsync(aliases: string[], options: UnsyncOptions): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  const picked = await selectRepos(repos, aliases, options, "unsync");
  if (!picked || picked.length === 0) return 1;

  // Unsync deletes the submodule's shared Git directory, which would take every attached tree's
  // branch history with it; force discards working-tree changes, not commit history.
  const inventory = listManagedTrees(repoRoot, repos, { dirtyAliases: [] });
  const blocked = picked
    .map((repo) => ({
      repo,
      entries: inventory.filter((tree) => tree.alias === repo.alias),
    }))
    .filter(({ entries }) => entries.length > 0);
  if (blocked.length > 0) {
    for (const { repo, entries } of blocked) {
      const listing = entries.map((tree) => tree.path).join(", ");
      log.error(
        `${repo.alias}: managed trees exist (${listing}). Unsync would delete the submodule Git directory they share, so remove them first with "oms tree remove ${repo.alias} <task>". The submodule, its Git directory, and the trees were preserved.`,
      );
    }
    return 1;
  }

  const manifest = prepareTopologyMutation(repoRoot, "unsyncing");
  if (!manifest.ok) return manifest.code;

  const outcomes = new Map<string, OperationResult>();
  for (const repo of picked) {
    log.step(`${repo.alias}: unsync`);
    const outcome = unsyncRepo(repo, repoRoot, options.force ?? false);
    if (outcome === "removed") {
      log.success(`${repo.alias}: unsynced`);
      outcomes.set(repo.alias, "unsynced");
      continue;
    }
    if (outcome === "nothing-to-remove") {
      log.info(`${repo.alias}: nothing to remove`);
      outcomes.set(repo.alias, "unsynced");
      continue;
    }
    outcomes.set(repo.alias, "failed");
  }
  const results = [...outcomes.values()];

  const topoExit = await finalizeTopology({
    repoRoot,
    requested: picked.map((r) => r.alias),
    kind: "remove",
    commit: options.commit,
    allSucceeded: !results.includes("failed"),
    metadataPlans: [],
    omsYamlBytes: manifest.bytes,
  });

  if (results.length > 1 || options.all) printSummary(results);
  // Name the failed aliases so a buried failure among several isn't read as "all unsynced". The
  // specific cause was already logged per alias by unsyncRepo (dirty tree, conflict, in-progress
  // root op, or occupied path), so the aggregate must not assert a single contradictory cause.
  const failed = picked.filter((repo) => outcomes.get(repo.alias) === "failed").map((r) => r.alias);
  if (failed.length > 0) {
    log.error(`Not unsynced: ${failed.join(", ")}. See the per-alias error above for each.`);
  }
  return exitFromResults(results) || topoExit;
}
