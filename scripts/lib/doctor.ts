import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "@clack/prompts";
import {
  GITIGNORE_ENTRY,
  MANIFEST_FILENAME,
  MIN_GIT_MAJOR,
  MIN_GIT_MINOR,
} from "./constants.js";
import {
  currentBranch,
  inspectWorkspaceGitIdentity,
  isRegisteredSubmodule,
  parseGitVersion,
  isGitVersionSupported,
  aliasDir,
  submoduleInitialized,
  submodulePath,
  runGit,
} from "./git.js";
import { abortOnLegacyRenameAt, abortOnLegacyWorktree, emitLegacyRenameHintWalkUp, loadRepos } from "./manifest.js";
import { pinState } from "./status.js";
import { gitignoreIgnoresOms } from "./workspace-ignore.js";
import { inspectWorkspaceMutationLock, readWorkspaceOwnership } from "./workspace-mutation.js";
import { readModeSwitchJournal } from "./mode-switch-journal.js";
import { commonRepoPath } from "./worktree-paths.js";
import { inspectWorktreeInventory, verifyCommonRepository } from "./worktree-inspection.js";
import { discoverWorktreeOrphanAliases } from "./worktree-unsync.js";
import { validateWorktreeRemoteUrl } from "./manifest.js";
import { inspectFetchProvenance } from "./worktree-sync.js";
import { inspectControlFileExcludes } from "./workspace-exclude.js";

function diagnoseWorktreeMode(
  repoRoot: string,
  repos: Array<{ alias: string; remotes: Record<string, string> }>,
): number {
  let warnings = 0;
  let ownership;
  try {
    ownership = readWorkspaceOwnership(repoRoot);
  } catch (error) {
    log.warn(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (!ownership) {
    log.info("Workspace ownership is not initialized; the first mutating command will create it under the workspace lock.");
  }
  if (existsSync(join(repoRoot, ".gitmodules"))) {
    log.warn(".gitmodules remains in worktree mode; finish or resume the mode transition before syncing.");
    warnings++;
  }
  const orphans = ownership ? discoverWorktreeOrphanAliases(repoRoot, repos) : [];
  for (const alias of orphans) {
    log.warn(`${alias}: owned common repository is orphaned from oms.yaml. Inspect it, then run "oms unsync ${alias}" explicitly.`);
    warnings++;
  }
  for (const repo of repos) {
    const common = commonRepoPath(repoRoot, repo.alias);
    if (!existsSync(common)) {
      log.info(`${repo.alias}: not synced`);
      continue;
    }
    if (!ownership) {
      log.warn(`${repo.alias}: common repository exists before workspace ownership is initialized; treat it as foreign until ownership can be proven.`);
      warnings++;
      continue;
    }
    try {
      verifyCommonRepository(repoRoot, repo.alias, ownership.workspaceId);
      const relative = runGit(common, ["config", "--bool", "worktree.useRelativePaths"]);
      if (!relative.success || relative.stdout.trim() !== "true") {
        log.warn(`${repo.alias}: worktree.useRelativePaths is not enabled; Git 2.48 portable metadata must be restored before mutation.`);
        warnings++;
      }
      for (const [remote, expectedUrl] of Object.entries(repo.remotes)) {
        try {
          validateWorktreeRemoteUrl(expectedUrl, `repository ${repo.alias} remote ${remote}`);
        } catch (error) {
          log.warn(error instanceof Error ? error.message : String(error));
          warnings++;
        }
        const urls = runGit(common, ["config", "--get-all", `remote.${remote}.url`]);
        const pushUrls = runGit(common, ["config", "--get-all", `remote.${remote}.pushurl`]);
        const refspecs = runGit(common, ["config", "--get-all", `remote.${remote}.fetch`]);
        const configured = urls.success ? urls.stdout.split("\n").filter(Boolean) : [];
        if (configured.length !== 1 || configured[0] !== expectedUrl || pushUrls.stdout.trim()) {
          log.warn(`${repo.alias}: declared remote ${remote} endpoint configuration drifted; run "oms sync ${repo.alias}" after resolving policy warnings.`);
          warnings++;
        }
        if (!refspecs.success || refspecs.stdout.trim() !== `+refs/heads/*:refs/remotes/${remote}/*`) {
          log.warn(`${repo.alias}: declared remote ${remote} fetch refspec drifted; run "oms sync ${repo.alias}".`);
          warnings++;
        }
        const provenance = inspectFetchProvenance(repoRoot, common, repo, remote);
        if (provenance.kind === "missing") {
          log.warn(`${repo.alias}: ${remote} has no successful-fetch provenance; cached refs must not be trusted until "oms fetch ${repo.alias} --remote ${remote}" succeeds.`);
          warnings++;
        } else if (provenance.kind === "untrusted") {
          log.warn(`${repo.alias}: ${remote} fetch provenance is untrusted (${provenance.reason}); fetch successfully before cached-ref fallback.`);
          warnings++;
        }
      }
      const configuredRemotes = runGit(common, ["remote"]);
      if (!configuredRemotes.success) throw new Error(`${repo.alias}: could not inspect configured remotes`);
      for (const remote of configuredRemotes.stdout.split("\n").filter(Boolean)) {
        if (!Object.hasOwn(repo.remotes, remote)) log.info(`${repo.alias}: undeclared remote ${remote} is preserved but never selected automatically.`);
      }
      const rewrites = runGit(common, ["config", "--local", "--get-regexp", "^url\\..*\\.(insteadOf|pushInsteadOf)$"]);
      if (rewrites.success && rewrites.stdout.trim()) {
        log.warn(`${repo.alias}: local URL rewrite configuration violates managed endpoint policy; remove it before network operations.`);
        warnings++;
      }
      const inventory = inspectWorktreeInventory(repoRoot, repo.alias, ownership.workspaceId);
      if (inventory.worktrees.length === 0) log.info(`${repo.alias}: common repository OK; no linked worktrees`);
      for (const worktree of inventory.worktrees) {
        if (worktree.locked) {
          log.warn(`${repo.alias}: ${worktree.path} is locked; unlock it explicitly before remove, unsync, or mode switch.`);
          warnings++;
        }
        if (!worktree.managed) {
          log.warn(`${repo.alias}: external or ownership-ambiguous worktree ${worktree.path} is outside OMS mutation scope.`);
          warnings++;
        }
        if (worktree.stale && !worktree.safeToPrune) {
          log.warn(`${repo.alias}: stale registration ${worktree.path} may have been moved manually. Run "git -C ${common} worktree repair <actual-path>", verify "oms worktree list ${repo.alias}", then retry; doctor does not repair or prune it.`);
          warnings++;
        } else if (worktree.stale) {
          log.warn(`${repo.alias}: stale managed registration ${worktree.path} is safely prunable by the next sync.`);
          warnings++;
        } else if (worktree.managed) {
          log.success(`${worktree.target}: managed worktree OK`);
        }
      }
    } catch (error) {
      log.warn(`${repo.alias}: ${error instanceof Error ? error.message : String(error)}`);
      warnings++;
    }
  }
  if (ownership) {
    for (const issue of inspectControlFileExcludes(repoRoot, ownership.workspaceId, { mode: "worktree", repos })) {
      log.warn(`${issue}. Run "oms sync" to reconcile it after resolving marker or lock conflicts.`);
      warnings++;
    }
  }
  return warnings;
}

function diagnoseSubmoduleIncompatibleTopology(repoRoot: string): number {
  let warnings = 0;
  for (const path of [join(repoRoot, ".oms", "repos"), join(repoRoot, ".oms", "provisioning"), join(repoRoot, ".oms", "fetch-provenance")]) {
    if (existsSync(path)) {
      log.warn(`${path}: worktree-mode state remains in submodule mode; resume or repair the mode transition before syncing.`);
      warnings++;
    }
  }
  return warnings;
}

export async function runDoctor(): Promise<number> {
  const loaded = loadRepos();
  if (!loaded) {
    emitLegacyRenameHintWalkUp();
    return 1;
  }
  const { repos, repoRoot } = loaded;
  if (abortOnLegacyRenameAt(repoRoot)) return 1;

  log.success(`Workspace manifest directory: ${repoRoot}`);
  log.success(`${MANIFEST_FILENAME}: ${repos.length} repo(s) configured`);

  const git = spawnSync("git", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (git.status !== 0) {
    log.error("git: not found");
    return 1;
  }
  log.success(`git: ${git.stdout.trim()}`);

  let warnings = 0;

  try {
    const transition = readModeSwitchJournal(repoRoot);
    if (transition) {
      log.warn(`${transition.transitionId}: mode switch ${transition.sourceMode} -> ${transition.targetMode} is paused at ${transition.phase}. Resume "oms mode switch ${transition.targetMode} ${transition.sync ? "--sync" : "--no-sync"}${transition.commit ? " --commit" : ""}${transition.force ? " --force" : ""}".`);
      warnings++;
    }
  } catch (error) {
    log.warn(error instanceof Error ? error.message : String(error));
    warnings++;
  }

  const mutationLock = inspectWorkspaceMutationLock(repoRoot);
  if (mutationLock.kind === "active") {
    log.warn(
      `.oms-mutation.lock is owned by active ${mutationLock.operation} process ${mutationLock.pid} since ${mutationLock.startedAt}; wait for it to finish.`,
    );
    warnings++;
  } else if (mutationLock.kind === "stale") {
    log.warn(
      `.oms-mutation.lock refers to non-running ${mutationLock.operation} process ${mutationLock.pid}. Verify no OMS mutation is active, then remove only ${repoRoot}/.oms-mutation.lock and retry.`,
    );
    warnings++;
  } else if (mutationLock.kind === "malformed") {
    log.warn(`${mutationLock.reason}. Do not remove it until you verify that no OMS mutation is active.`);
    warnings++;
  }

  const parsed = parseGitVersion(git.stdout);
  if (!parsed) {
    log.warn(
      `git: could not parse version from "${git.stdout.trim()}"; oms expects git >=${MIN_GIT_MAJOR}.${MIN_GIT_MINOR}.`,
    );
    warnings++;
  } else if (!isGitVersionSupported(parsed)) {
    log.warn(
      `git ${parsed.major}.${parsed.minor} is older than the required ${MIN_GIT_MAJOR}.${MIN_GIT_MINOR}. Portable relative worktree metadata requires Git ${MIN_GIT_MAJOR}.${MIN_GIT_MINOR} or newer — upgrade git.`,
    );
    warnings++;
  }

  const identity = inspectWorkspaceGitIdentity(repoRoot);
  if (loaded.mode === "worktree") {
    if (identity.kind === "match") log.success(`Enclosing Git root: ${repoRoot}`);
    else if (identity.kind === "mismatch") log.success(`Enclosing Git root: ${identity.gitTopLevel} (workspace is nested)`);
    else if (identity.kind === "no-work-tree") log.info("No enclosing Git repository; worktree mode remains fully supported.");
    else {
      log.warn(`Enclosing Git relationship could not be inspected: ${identity.reason}`);
      warnings++;
    }
    warnings += diagnoseWorktreeMode(repoRoot, repos);
    return warnings > 0 ? 2 : 0;
  }
  if (identity.kind === "no-work-tree") {
    log.warn(
      `workspace is not a git repository. oms manages sources as submodules; run "git init" at ${repoRoot}.`,
    );
    return 2;
  }
  if (identity.kind === "mismatch") {
    log.error(
      `Workspace manifest directory ${repoRoot} does not match the root Git top-level ${identity.gitTopLevel}. ` +
        `Move ${MANIFEST_FILENAME} to ${identity.gitTopLevel}, or initialize a separate Git repository at ${repoRoot}.`,
    );
    return 1;
  }
  if (identity.kind === "indeterminate") {
    log.error(
      `Could not verify that workspace ${repoRoot} is the root Git top-level: ${identity.reason}. ` +
        "Retry after the workspace path and Git repository are accessible.",
    );
    return 1;
  }
  log.success(`Workspace root: ${repoRoot}`);

  warnings += diagnoseSubmoduleIncompatibleTopology(repoRoot);

  try {
    const ownership = readWorkspaceOwnership(repoRoot);
    if (ownership) {
      for (const issue of inspectControlFileExcludes(repoRoot, ownership.workspaceId, { mode: "submodule", repos })) {
        log.warn(`${issue}. Run "oms sync" to reconcile it after resolving marker or lock conflicts.`);
        warnings++;
      }
    }
  } catch (error) {
    log.warn(error instanceof Error ? error.message : String(error));
    warnings++;
  }

  if (abortOnLegacyWorktree(repoRoot, repos)) return 1;

  if (gitignoreIgnoresOms(repoRoot)) {
    log.warn(`.gitignore excludes ${GITIGNORE_ENTRY}, but submodules must be tracked. Run "oms sync" to remove it.`);
    warnings++;
  }

  for (const repo of repos) {
    if (!isRegisteredSubmodule(repoRoot, submodulePath(repo.alias))) {
      log.info(`${repo.alias}: not synced`);
      continue;
    }
    if (!submoduleInitialized(repoRoot, repo.alias)) {
      log.warn(`${repo.alias}: registered but not initialized. Run "oms sync ${repo.alias}".`);
      warnings++;
      continue;
    }
    const dir = aliasDir(repoRoot, repo.alias);
    const branch = currentBranch(dir);
    if (!branch) {
      log.warn(`${repo.alias}: detached HEAD. Run "oms branch switch ${repo.alias} <branch>" to get on a branch.`);
      warnings++;
    } else {
      log.success(`${repo.alias}: submodule OK (branch=${branch})`);
    }
    if (pinState(repoRoot, repo.alias) === "moved") {
      log.info(`${repo.alias}: working commit differs from the recorded pointer. Commit oms/${repo.alias} to record it.`);
    }
  }

  return warnings > 0 ? 2 : 0;
}
