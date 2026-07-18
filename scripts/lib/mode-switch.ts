import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { cancel, log } from "@clack/prompts";
import { aliasDir, inspectWorkspaceGitIdentity, isDirty, runGit, submodulePath } from "./git.js";
import { loadRepos } from "./manifest.js";
import { applyManifestModeEdit, planManifestModeEdit } from "./mode-manifest.js";
import {
  readModeSwitchJournal,
  removeModeSwitchJournal,
  writeModeSwitchJournal,
  type ModeSwitchJournal,
} from "./mode-switch-journal.js";
import { guardedSelect, isCancel, promptQueueActive } from "./prompt-adapter.js";
import { runSync, runUnsync } from "./repo-ops.js";
import { validateModeSwitchTargetSync } from "./repo-ops.js";
import { gitOperationInProgress, gitlinkState } from "./status.js";
import type { Repo, WorkspaceMode } from "./types.js";
import {
  bindMutationLockToTransition,
  currentMutationIdentity,
  readWorkspaceOwnership,
} from "./workspace-mutation.js";
import { discoverWorktreeOrphanAliases } from "./worktree-unsync.js";
import {
  cleanupModeSwitchStaging,
  installStagedSubmoduleRepositories,
  installStagedWorktreeRepositories,
  inventorySubmoduleSources,
  nonReconstructibleItems,
  stageSubmodulePreservation,
  stageSubmoduleTargets,
  worktreePointerCandidates,
  type SubmoduleSourceInventory,
  type WorktreePointerSource,
} from "./mode-switch-storage.js";
import { commonRepoPath, parseManagedTarget, worktreeAliasPath } from "./worktree-paths.js";
import { inspectWorktreeInventory, parseWorktreeRegistrations } from "./worktree-inspection.js";
import { isTestMode } from "./env.js";

export type ModeSwitchOptions = {
  sync?: boolean;
  noSync?: boolean;
  force?: boolean;
  commit?: boolean;
  preserveLocal?: boolean;
  source?: string[];
};

function interactive(): boolean {
  return Boolean(process.stdin.isTTY) || promptQueueActive();
}

async function resolveSyncScope(options: ModeSwitchOptions): Promise<boolean | null> {
  if (options.sync && options.noSync) {
    log.error("Choose exactly one completion scope: --sync or --no-sync.");
    return null;
  }
  if (options.sync) return true;
  if (options.noSync) return false;
  if (!interactive()) {
    log.error('Mode switch requires a completion scope. Re-run with "--sync" to provision target topology or "--no-sync" for transition only.');
    return null;
  }
  const selected = await guardedSelect<string>({
    message: "Choose the mode-switch completion scope",
    options: [
      { value: "sync", label: "Transition and sync", hint: "create target-mode repositories" },
      { value: "no-sync", label: "Transition only", hint: "leave target-mode repositories absent" },
    ],
  });
  if (isCancel(selected)) {
    cancel("Mode switch cancelled before mutation.");
    return null;
  }
  return selected === "sync";
}

function rootPaths(repos: Array<{ alias: string }>): string[] {
  return ["oms.yaml", ".gitmodules", ...repos.map(({ alias }) => submodulePath(alias))];
}

function sourceTopologyExists(workspaceRoot: string, mode: WorkspaceMode, repos: Array<{ alias: string }>): boolean {
  if (mode === "worktree") {
    return repos.some(({ alias }) => existsSync(join(workspaceRoot, ".oms", "repos", `${alias}.git`)))
      || repos.some(({ alias }) => existsSync(join(workspaceRoot, "oms", alias)));
  }
  return existsSync(join(workspaceRoot, ".gitmodules"))
    || repos.some(({ alias }) => existsSync(join(workspaceRoot, submodulePath(alias))));
}

function fileSnapshot(path: string): { hash: string; size: number } | null {
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  return { hash: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}

function journalRootIndex(workspaceRoot: string): { hash: string; size: number } | null {
  if (inspectWorkspaceGitIdentity(workspaceRoot).kind !== "match") return null;
  const result = runGit(workspaceRoot, ["rev-parse", "--git-path", "index"]);
  if (!result.success) return null;
  const path = result.stdout.trim();
  return fileSnapshot(isAbsolute(path) ? path : resolve(workspaceRoot, path));
}

function journalExclude(workspaceRoot: string, workspaceId: string): ModeSwitchJournal["exclude"] {
  const identity = inspectWorkspaceGitIdentity(workspaceRoot);
  if (identity.kind !== "match" && identity.kind !== "mismatch") return null;
  const result = runGit(workspaceRoot, ["rev-parse", "--git-path", "info/exclude"]);
  if (!result.success) return null;
  const path = result.stdout.trim();
  const absolute = isAbsolute(path) ? path : resolve(workspaceRoot, path);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) return null;
  const content = readFileSync(absolute, "utf8");
  const begin = content.indexOf(`# oms workspace ${workspaceId} begin`);
  const endToken = `# oms workspace ${workspaceId} end`;
  const end = content.indexOf(endToken);
  if (begin === -1 || end === -1) return null;
  return {
    hash: createHash("sha256").update(content).digest("hex"),
    markerStart: begin,
    markerEnd: end + endToken.length,
  };
}

function rootHead(workspaceRoot: string): string | null {
  const result = runGit(workspaceRoot, ["rev-parse", "--verify", "HEAD"]);
  return result.success ? result.stdout.trim() : null;
}

function transitionCommitAlreadySucceeded(
  workspaceRoot: string,
  journal: ModeSwitchJournal,
  repos: Array<{ alias: string }>,
): boolean {
  if (!journal.commit) return false;
  const current = rootHead(workspaceRoot);
  if (!current) return false;
  const parentless = journal.rootHeadBefore === null;
  if (parentless) {
    // A fresh root repository produces a valid parentless first commit.
    if (runGit(workspaceRoot, ["rev-parse", "--verify", "HEAD^"]).success) return false;
  } else {
    if (current === journal.rootHeadBefore) return false;
    const parent = runGit(workspaceRoot, ["rev-parse", "HEAD^"]);
    if (!parent.success || parent.stdout.trim() !== journal.rootHeadBefore) return false;
  }
  const subject = runGit(workspaceRoot, ["show", "-s", "--format=%s", "HEAD"]);
  if (!subject.success || subject.stdout.trim() !== `chore(oms): switch workspace mode to ${journal.targetMode}`) return false;
  const manifest = runGit(workspaceRoot, ["show", "HEAD:oms.yaml"]);
  if (!manifest.success || createHash("sha256").update(Buffer.from(manifest.stdout)).digest("hex") !== journal.expectedManifestHash) return false;
  const changed = parentless
    ? runGit(workspaceRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", "HEAD"])
    : runGit(workspaceRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]);
  const allowed = new Set(rootPaths(repos));
  const paths = changed.success ? changed.stdout.split("\n").filter(Boolean) : [];
  if (!paths.includes("oms.yaml") || !paths.every((path) => allowed.has(path))) return false;
  return verifySelectedGitlinks(workspaceRoot, journal, undefined, "HEAD");
}

function modeSwitchCrashHook(point: string): void {
  if (isTestMode() && process.env.OMS_TEST_CRASH_AT === point) process.exit(137);
}

function verifySelectedGitlinks(
  workspaceRoot: string,
  journal: ModeSwitchJournal,
  indexEnv?: NodeJS.ProcessEnv,
  treeish?: string,
): boolean {
  if (!journal.sync || journal.targetMode !== "submodule") return true;
  for (const selected of journal.selectedSources) {
    if (!selected.oid) return false;
    const path = submodulePath(selected.alias);
    const entry = treeish
      ? runGit(workspaceRoot, ["ls-tree", treeish, "--", path])
      : runGit(workspaceRoot, ["ls-files", "--stage", "--", path], false, indexEnv);
    const match = treeish
      ? entry.stdout.match(/^160000 commit ([0-9a-f]{40,64})\t/)
      : entry.stdout.match(/^160000 ([0-9a-f]{40,64}) 0\t/);
    if (!entry.success || !match || match[1] !== selected.oid || entry.stdout.trim().split("\n").length !== 1) return false;
  }
  return true;
}

function preflightRootSafety(workspaceRoot: string, repos: Array<{ alias: string }>, commit: boolean): number {
  if (inspectWorkspaceGitIdentity(workspaceRoot).kind !== "match") return 0;
  const operation = gitOperationInProgress(workspaceRoot);
  if (operation) {
    log.error(`Root repository has ${operation} in progress; resolve or abort it before mode switch.`);
    return 1;
  }
  if (existsSync(join(workspaceRoot, ".git", "index.lock"))) {
    log.error("Root index lock exists; wait for the owning Git process or remove a proven stale lock before mode switch.");
    return 1;
  }
  const unmerged = runGit(workspaceRoot, ["ls-files", "-u"]);
  if (!unmerged.success || unmerged.stdout.trim()) {
    log.error("Root repository has unmerged index entries; resolve them before mode switch.");
    return 1;
  }
  if (commit) {
    const allowed = new Set(rootPaths(repos));
    const staged = runGit(workspaceRoot, ["diff", "--cached", "--name-only", "-z"]);
    if (!staged.success) return 2;
    const unrelated = staged.stdout.split("\0").filter(Boolean).filter((path) => !allowed.has(path));
    if (unrelated.length > 0) {
      log.error(`Root repository has unrelated staged changes (${unrelated.join(", ")}). Commit or unstage them before mode switch --commit.`);
      return 1;
    }
  }
  return 0;
}

function inspectSubmoduleCheckoutSafety(
  workspaceRoot: string,
  repos: Repo[],
  force: boolean,
): 0 | 1 {
  let safetyFailure = false;
  for (const repo of repos) {
    const state = gitlinkState(workspaceRoot, repo.alias);
    if (state.conflict) {
      log.error(`${repo.alias}: root gitlink has unmerged index stages; resolve them before mode switch.`);
      safetyFailure = true;
      continue;
    }
    if (!state.initialized) continue;
    const dir = aliasDir(workspaceRoot, repo.alias);
    let registrations;
    try {
      registrations = parseWorktreeRegistrations(dir).filter(({ bare }) => !bare);
    } catch (error) {
      log.error(`${repo.alias}: ${error instanceof Error ? error.message : String(error)}`);
      safetyFailure = true;
      continue;
    }
    const expected = realpathSync(dir);
    const gitDirResult = runGit(dir, ["rev-parse", "--absolute-git-dir"]);
    let expectedGitDir: string | null = null;
    try { expectedGitDir = gitDirResult.success ? realpathSync(gitDirResult.stdout.trim()) : null; } catch {}
    for (const registration of registrations) {
      if (registration.locked) {
        log.error(`${repo.alias}: linked worktree ${registration.path} is locked. Unlock it explicitly before mode switch; --force cannot bypass this boundary.`);
        safetyFailure = true;
      } else {
        let actual: string | null = null;
        try { actual = realpathSync(registration.path); } catch {}
        if (actual !== expected && actual !== expectedGitDir) {
          log.error(`${repo.alias}: external linked worktree ${registration.path} blocks mode switch. Remove or detach it with Git before retrying; --force cannot bypass this boundary.`);
          safetyFailure = true;
        }
      }
    }
    const operation = gitOperationInProgress(dir);
    const dirty = isDirty(dir);
    if ((operation || dirty) && !force) {
      log.error(`${repo.alias}: ${operation ? `${operation} in progress` : "dirty source checkout"} blocks mode switch; clean it or use --force after reviewing local loss.`);
      safetyFailure = true;
    } else if (operation || dirty) {
      log.warn(`${repo.alias}: force will discard ${operation ? `operation=${operation}` : "dirty source checkout"}.`);
    }
  }
  return safetyFailure ? 1 : 0;
}

function inspectWorktreeTransitionBoundaries(workspaceRoot: string, repos: Repo[], workspaceId: string): boolean {
  let blocked = false;
  for (const repo of repos) {
    const common = commonRepoPath(workspaceRoot, repo.alias);
    if (!existsSync(common)) continue;
    try {
      const inventory = inspectWorktreeInventory(workspaceRoot, repo.alias, workspaceId);
      const aliasPath = worktreeAliasPath(workspaceRoot, repo.alias);
      if (existsSync(aliasPath)) {
        const managedNames = new Set(inventory.worktrees.filter(({ managed, name }) => managed && name).map(({ name }) => name!));
        const unexpected = readdirSync(aliasPath).filter((name) => !managedNames.has(name));
        if (unexpected.length > 0) {
          log.error(`${repo.alias}: target submodule path contains non-worktree entries (${unexpected.join(", ")}); move them before mode switch.`);
          blocked = true;
        }
      }
      for (const worktree of inventory.worktrees) {
        if (worktree.locked) {
          log.error(`${repo.alias}: linked worktree ${worktree.path} is locked. Unlock it explicitly before mode switch; --force cannot bypass this boundary.`);
          blocked = true;
        } else if (!worktree.managed) {
          log.error(`${repo.alias}: external or ownership-ambiguous worktree ${worktree.path} blocks mode switch. Detach it with Git before retrying; --force cannot bypass this boundary.`);
          blocked = true;
        }
      }
    } catch (error) {
      log.error(`${repo.alias}: ${error instanceof Error ? error.message : String(error)}`);
      blocked = true;
    }
  }
  return blocked;
}

function discloseSubmoduleItems(inventories: SubmoduleSourceInventory[], force: boolean): void {
  for (const inventory of inventories) {
    for (const item of inventory.items.filter(({ reconstructible }) => !reconstructible)) {
      const detail = `${item.kind}${item.refname ? ` ${item.refname}` : ""} ${item.objectType} ${item.oid} (${item.role})`;
      if (force) log.warn(`${inventory.alias}: force will discard ${detail}.`);
      else log.warn(`${inventory.alias}: ${detail} is not completely reconstructible from freshly inspected declared remotes.`);
    }
  }
}

async function resolveSubmodulePreservation(
  inventories: SubmoduleSourceInventory[],
  sync: boolean,
  options: ModeSwitchOptions,
): Promise<{ code: 0; preserve: boolean; sync: boolean } | { code: 1 | 2 }> {
  if (inventories.some(({ fetchFailed }) => fetchFailed) && !options.force) {
    log.error("Fresh publication verification failed; source topology was left unchanged. Retry when every declared remote is available, or use --force after reviewing stale knowledge.");
    return { code: 2 };
  }
  const protectedItems = nonReconstructibleItems(inventories);
  if (protectedItems.length === 0) return { code: 0, preserve: false, sync };
  discloseSubmoduleItems(inventories, Boolean(options.force));
  log.info("Mode switch never pushes or otherwise writes to a remote; preserve locally, publish manually and retry, or explicitly force discard.");
  if (options.force) return { code: 0, preserve: false, sync };
  let preserve = Boolean(options.preserveLocal);
  if (!preserve) {
    if (!interactive()) {
      log.error('Non-reconstructible source state requires "--sync --preserve-local" or "--force". Mode switch never pushes; publish suitable refs manually and retry if preferred.');
      return { code: 1 };
    }
    const choice = await guardedSelect<string>({
      message: "Local source state is not reconstructible from declared remotes",
      options: [
        { value: "preserve", label: "Preserve locally", hint: "copy verified raw closure into target common repositories" },
        { value: "cancel", label: "Cancel", hint: "publish or repair state manually, then retry" },
      ],
    });
    if (isCancel(choice) || choice === "cancel") {
      cancel("Mode switch cancelled without topology changes. Publish suitable state manually, then rerun; mode switch never pushes.");
      return { code: 1 };
    }
    preserve = true;
  }
  if (!sync) {
    if (!interactive()) {
      log.error('Local preservation requires target topology. Re-run with "--sync --preserve-local", or cancel and publish manually.');
      return { code: 1 };
    }
    const choice = await guardedSelect<string>({
      message: "Local preservation requires transition plus target sync",
      options: [
        { value: "sync", label: "Change to transition and sync", hint: "install verified preservation repositories" },
        { value: "cancel", label: "Cancel", hint: "leave source topology unchanged" },
      ],
    });
    if (isCancel(choice) || choice === "cancel") return { code: 1 };
    sync = true;
  }
  if (protectedItems.some(({ available }) => !available)) {
    log.error("At least one protected item has an unavailable or incomplete raw object closure and cannot be claimed as preserved. Restore or publish it, select --force to discard it, or cancel.");
    return { code: 2 };
  }
  return { code: 0, preserve, sync };
}

async function resolveWorktreeSources(
  workspaceRoot: string,
  repos: Repo[],
  workspaceId: string,
  requested: string[],
): Promise<WorktreePointerSource[] | null> {
  const candidates = worktreePointerCandidates(workspaceRoot, repos, workspaceId);
  const explicit = new Map<string, string>();
  try {
    for (const value of requested) {
      const target = parseManagedTarget(value);
      if (explicit.has(target.alias)) throw new Error(`--source was repeated for alias ${target.alias}`);
      explicit.set(target.alias, value);
    }
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    return null;
  }
  const unknown = [...explicit.keys()].filter((alias) => !repos.some((repo) => repo.alias === alias));
  if (unknown.length > 0) {
    log.error(`--source names unknown alias(es): ${unknown.join(", ")}`);
    return null;
  }
  const selected: WorktreePointerSource[] = [];
  for (const repo of repos) {
    const viable = candidates.get(repo.alias) ?? [];
    const named = explicit.get(repo.alias);
    if (named) {
      const match = viable.find(({ target }) => target === named);
      if (!match) {
        log.error(`${named}: source is not an ownership-verified readable managed worktree with complete committed object closure.`);
        return null;
      }
      selected.push(match);
      continue;
    }
    if (viable.length === 1) {
      log.info(`${repo.alias}: selected sole viable pointer source ${viable[0].target} at ${viable[0].oid}.`);
      selected.push(viable[0]);
      continue;
    }
    if (viable.length === 0) {
      selected.push({ alias: repo.alias, target: null, oid: null, branch: null, upstream: null, sourceRepo: commonRepoPath(workspaceRoot, repo.alias) });
      continue;
    }
    if (!interactive()) {
      log.error(`${repo.alias}: multiple viable pointer sources exist (${viable.map(({ target, oid }) => `${target} ${oid}`).join(", ")}). Re-run with one repeated "--source ${repo.alias}/<name>" choice.`);
      return null;
    }
    const choice = await guardedSelect<string>({
      message: `${repo.alias}: choose the worktree HEAD for the target submodule gitlink`,
      options: viable.map(({ target, oid, branch }) => ({ value: target!, label: target!, hint: `${branch ?? "detached"} ${oid}` })),
    });
    if (isCancel(choice)) return null;
    selected.push(viable.find(({ target }) => target === choice)!);
  }
  return selected;
}

function finalizeRoot(
  workspaceRoot: string,
  repos: Array<{ alias: string }>,
  targetMode: WorkspaceMode,
  commit: boolean,
  journal: ModeSwitchJournal,
): number {
  const identity = inspectWorkspaceGitIdentity(workspaceRoot);
  if (identity.kind !== "match") return 0;
  const operation = gitOperationInProgress(workspaceRoot);
  if (operation) {
    log.error(`Root repository has ${operation} in progress; resolve or abort it before mode switch.`);
    return 1;
  }
  if (existsSync(join(workspaceRoot, ".git", "index.lock"))) {
    log.error("Root index lock exists; wait for the owning Git process or remove a proven stale lock before mode switch.");
    return 1;
  }
  const unmerged = runGit(workspaceRoot, ["ls-files", "-u"]);
  if (!unmerged.success || unmerged.stdout.trim()) {
    log.error("Root repository has unmerged index entries; resolve them before mode switch.");
    return 1;
  }
  const paths = rootPaths(repos);
  const staged = runGit(workspaceRoot, ["diff", "--cached", "--name-only", "-z"]);
  if (!staged.success) return 2;
  const allowed = new Set(paths);
  const unrelated = staged.stdout.split("\0").filter(Boolean).filter((path) => !allowed.has(path));
  if (commit && unrelated.length > 0) {
    log.error(`Root repository has unrelated staged changes (${unrelated.join(", ")}). Commit or unstage them before mode switch --commit.`);
    return 1;
  }
  const indexResult = runGit(workspaceRoot, ["rev-parse", "--git-path", "index"]);
  if (!indexResult.success) return 2;
  const indexValue = indexResult.stdout.trim();
  const indexPath = isAbsolute(indexValue) ? indexValue : resolve(workspaceRoot, indexValue);
  const temporaryIndex = `${indexPath}.oms-mode-switch.${process.pid}.${randomUUID()}`;
  const indexEnv = { GIT_INDEX_FILE: temporaryIndex };
  try {
    if (existsSync(indexPath)) copyFileSync(indexPath, temporaryIndex);
    else if (!runGit(workspaceRoot, ["read-tree", "--empty"], false, indexEnv).success) return 2;
    if (!runGit(workspaceRoot, ["add", "--", "oms.yaml"], false, indexEnv).success) return 2;
    const topologyPaths = paths.filter((path) => path !== "oms.yaml").filter((path) =>
      existsSync(join(workspaceRoot, path)) || runGit(workspaceRoot, ["ls-files", "--error-unmatch", "--", path]).success);
    if (topologyPaths.length > 0) {
      const topologyStage = targetMode === "worktree"
        ? runGit(workspaceRoot, ["add", "-u", "--", ...topologyPaths], false, indexEnv)
        : runGit(workspaceRoot, ["add", "-A", "--", ...topologyPaths], false, indexEnv);
      if (!topologyStage.success) return 2;
    }
    if (!verifySelectedGitlinks(workspaceRoot, journal, indexEnv)) {
      log.error("Target submodule gitlinks do not match the journal's verified selected OIDs; the real index was not changed.");
      return 1;
    }
    const stagedAfter = runGit(workspaceRoot, ["diff", "--cached", "--name-only", "-z"], false, indexEnv);
    if (!stagedAfter.success) return 2;
    const unexpected = stagedAfter.stdout.split("\0").filter(Boolean)
      .filter((path) => !allowed.has(path) && !unrelated.includes(path));
    if (unexpected.length > 0) {
      log.error(`Mode-switch temporary index contains unexpected paths (${unexpected.join(", ")}); the real index was not changed.`);
      return 1;
    }
    renameSync(temporaryIndex, indexPath);
  } finally {
    rmSync(temporaryIndex, { force: true });
    rmSync(`${temporaryIndex}.lock`, { force: true });
  }
  if (!commit) return 0;
  if (!runGit(workspaceRoot, ["diff", "--quiet", "HEAD", "--", "oms.yaml"]).success) {
    log.info("Including the complete working-tree oms.yaml in the mode-switch commit without printing its contents.");
  }
  const commitPathsResult = runGit(workspaceRoot, ["diff", "--cached", "--name-only", "-z"]);
  if (!commitPathsResult.success) return 2;
  const commitPaths = commitPathsResult.stdout.split("\0").filter((path) => allowed.has(path));
  if (commitPaths.length === 0) return 0;
  const result = runGit(workspaceRoot, ["commit", "-m", `chore(oms): switch workspace mode to ${targetMode}`], true);
  if (!result.success) {
    log.error("Mode-switch root commit failed; transition-owned paths remain staged. Re-run the same mode switch command to recover.");
    return 2;
  }
  if (!transitionCommitAlreadySucceeded(workspaceRoot, journal, repos)) {
    log.error("Mode-switch root commit succeeded but its parent, manifest bytes, paths, or selected gitlinks did not verify; recovery state was retained.");
    return 2;
  }
  return 0;
}

/** Switches the workspace-wide repository topology under the shared mutation lock. */
export async function runModeSwitch(targetMode: string, options: ModeSwitchOptions): Promise<number> {
  if (targetMode !== "submodule" && targetMode !== "worktree") {
    log.error(`Invalid target mode "${targetMode}"; expected "submodule" or "worktree".`);
    return 1;
  }
  const loaded = loadRepos();
  if (!loaded) return 1;
  const edit = planManifestModeEdit(loaded.repoRoot, targetMode);
  let sync = await resolveSyncScope(options);
  if (sync === null) return 1;
  const prior = readModeSwitchJournal(loaded.repoRoot);
  if (prior && prior.targetMode !== targetMode) {
    log.error(`${prior.transitionId}: an interrupted switch to ${prior.targetMode} exists. Resume that target or run "oms doctor".`);
    return 1;
  }
  if (prior && (prior.sync !== sync || prior.commit !== Boolean(options.commit) || prior.force !== Boolean(options.force)
    || prior.preserveLocal !== Boolean(options.preserveLocal))) {
    log.error(`Mode-switch resume options must match the journal. Re-run with ${prior.sync ? "--sync" : "--no-sync"}${prior.commit ? " --commit" : ""}${prior.force ? " --force" : ""}${prior.preserveLocal ? " --preserve-local" : ""}.`);
    return 1;
  }
  if (prior) {
    const currentHash = createHash("sha256").update(readFileSync(join(loaded.repoRoot, "oms.yaml"))).digest("hex");
    if (prior.phase === "source-removed" && currentHash === prior.expectedManifestHash) {
      prior.phase = "manifest-updated";
      writeModeSwitchJournal(loaded.repoRoot, prior);
    }
    const afterCutover = ["manifest-updated", "target-synced", "root-finalized"].includes(prior.phase);
    const expectedHash = afterCutover ? prior.expectedManifestHash : prior.originalManifestHash;
    if (currentHash !== expectedHash) {
      log.error("oms.yaml drifted from the mode-switch journal; no further transition state was changed. Run \"oms doctor\".");
      return 1;
    }
  }
  if (loaded.mode === targetMode && !prior) {
    log.info(`Workspace already uses ${targetMode} mode; no transition is required.`);
    return 0;
  }
  if (targetMode === "submodule" && inspectWorkspaceGitIdentity(loaded.repoRoot).kind !== "match") {
    log.error("Switching to submodule mode requires the workspace manifest directory to be the canonical Git top-level.");
    return 1;
  }
  const rootSafety = preflightRootSafety(loaded.repoRoot, loaded.repos, options.commit ?? false);
  if (rootSafety !== 0) return rootSafety;
  const ownership = readWorkspaceOwnership(loaded.repoRoot);
  if (!ownership) throw new Error("Workspace ownership was not bootstrapped under the mutation lock");
  if (loaded.mode === "worktree") {
    const orphans = discoverWorktreeOrphanAliases(loaded.repoRoot, loaded.repos);
    if (orphans.length > 0) {
      log.error(`Mode switch is blocked by orphan managed aliases: ${orphans.join(", ")}. Run ${orphans.map((alias) => `"oms unsync ${alias}"`).join(", ")} first.`);
      return 1;
    }
  }
  const lockIdentity = currentMutationIdentity(loaded.repoRoot);
  let submoduleInventory: SubmoduleSourceInventory[] | null = null;
  let worktreeSources: WorktreePointerSource[] | null = null;
  if (!prior && loaded.mode === "submodule" && targetMode === "worktree"
    && sourceTopologyExists(loaded.repoRoot, loaded.mode, loaded.repos)) {
    if (inspectSubmoduleCheckoutSafety(loaded.repoRoot, loaded.repos, options.force ?? false) !== 0) return 1;
    try {
      submoduleInventory = inventorySubmoduleSources(loaded.repoRoot, loaded.repos);
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
    const preservation = await resolveSubmodulePreservation(submoduleInventory, sync, options);
    if (preservation.code !== 0) return preservation.code;
    sync = preservation.sync;
    options.preserveLocal = preservation.preserve;
  }
  if (!prior && loaded.mode === "worktree" && targetMode === "submodule" && sync) {
    if (inspectWorktreeTransitionBoundaries(loaded.repoRoot, loaded.repos, ownership.workspaceId)) return 1;
    for (const repo of loaded.repos) {
      const module = runGit(loaded.repoRoot, ["rev-parse", "--git-path", `modules/oms/${repo.alias}`]);
      const modulePath = module.stdout.trim();
      if (!module.success || !modulePath) {
        log.error(`${repo.alias}: target submodule Git directory could not be resolved.`);
        return 1;
      }
      const absoluteModule = isAbsolute(modulePath) ? modulePath : resolve(loaded.repoRoot, modulePath);
      if (existsSync(absoluteModule)) {
        log.error(`${repo.alias}: target submodule Git directory ${absoluteModule} already exists; inspect or remove the conflicting old topology before mode switch.`);
        return 1;
      }
    }
    worktreeSources = await resolveWorktreeSources(loaded.repoRoot, loaded.repos, ownership.workspaceId, options.source ?? []);
    if (!worktreeSources) return 1;
  } else if (!prior && (options.source?.length ?? 0) > 0) {
    log.error("--source is valid only for worktree-to-submodule transitions with --sync.");
    return 1;
  }
  const journal: ModeSwitchJournal = prior ?? {
    version: 1,
    transitionId: crypto.randomUUID(),
    lockOperationId: lockIdentity.operationId,
    workspaceId: ownership.workspaceId,
    sourceMode: loaded.mode,
    targetMode,
    sync,
    commit: options.commit ?? false,
    force: options.force ?? false,
    preserveLocal: options.preserveLocal ?? false,
    originalManifestHash: edit.originalHash,
    expectedManifestHash: edit.expectedHash,
    modeRange: edit.range,
    modeToken: edit.token,
    rootIndex: journalRootIndex(loaded.repoRoot),
    exclude: journalExclude(loaded.repoRoot, ownership.workspaceId),
    rootHeadBefore: rootHead(loaded.repoRoot),
    phase: "prepared",
    completedAliases: [],
    stagedRepositories: [],
    selectedSources: (worktreeSources ?? []).map(({ alias, target, oid }) => ({ alias, target, oid: oid ?? "" })),
    createdAt: new Date().toISOString(),
  };
  if (prior && prior.lockOperationId !== lockIdentity.operationId) journal.lockOperationId = lockIdentity.operationId;
  if (lockIdentity.transitionId === null) {
    bindMutationLockToTransition(loaded.repoRoot, journal.transitionId);
    modeSwitchCrashHook("mode-switch-after-lock-bind-before-journal");
  }
  else if (lockIdentity.transitionId !== journal.transitionId) {
    throw new Error("The held mutation lock does not match the mode-switch transition journal");
  }
  writeModeSwitchJournal(loaded.repoRoot, journal);
  modeSwitchCrashHook("mode-switch-after-journal");

  if (journal.phase === "prepared") {
    if (journal.stagedRepositories.length === 0 && journal.sourceMode === "submodule" && journal.preserveLocal) {
      try {
        submoduleInventory ??= inventorySubmoduleSources(loaded.repoRoot, loaded.repos);
        journal.stagedRepositories = stageSubmodulePreservation(loaded.repoRoot, loaded.repos, submoduleInventory, journal);
        writeModeSwitchJournal(loaded.repoRoot, journal);
      } catch (error) {
        log.error(`Preservation staging failed before source deletion: ${error instanceof Error ? error.message : String(error)}`);
        return 2;
      }
    }
    if (journal.stagedRepositories.length === 0 && journal.sourceMode === "worktree" && journal.targetMode === "submodule" && journal.sync) {
      try {
        worktreeSources ??= await resolveWorktreeSources(loaded.repoRoot, loaded.repos, ownership.workspaceId, options.source ?? []);
        if (!worktreeSources) return 1;
        journal.stagedRepositories = stageSubmoduleTargets(loaded.repoRoot, loaded.repos, worktreeSources, journal);
        journal.selectedSources = worktreeSources.map(({ alias, target, oid }, index) => ({
          alias,
          target,
          oid: oid ?? journal.stagedRepositories[index].selectedOid!,
        }));
        writeModeSwitchJournal(loaded.repoRoot, journal);
      } catch (error) {
        log.error(`Selected target staging failed before source deletion: ${error instanceof Error ? error.message : String(error)}`);
        return 2;
      }
    }
    const removal = sourceTopologyExists(loaded.repoRoot, loaded.mode, loaded.repos)
      ? await runUnsync(loaded.repos.map(({ alias }) => alias), {
          all: true,
          force: journal.force,
          commit: false,
          preservedOids: Object.fromEntries(journal.selectedSources.map(({ alias, oid }) => [alias, [oid]])),
        })
      : 0;
    if (removal !== 0) {
      log.error(`Mode switch paused before manifest cutover. Fix the preflight issue and retry "oms mode switch ${targetMode}${sync ? " --sync" : " --no-sync"}".`);
      return removal;
    }
    journal.completedAliases = loaded.repos.map(({ alias }) => alias);
    journal.phase = "source-removed";
    writeModeSwitchJournal(loaded.repoRoot, journal);
  }
  if (journal.phase === "source-removed") {
    applyManifestModeEdit(loaded.repoRoot, edit);
    modeSwitchCrashHook("mode-switch-after-manifest-rename");
    journal.phase = "manifest-updated";
    writeModeSwitchJournal(loaded.repoRoot, journal);
  }
  if (journal.phase === "manifest-updated" && sync) {
    const targetLoaded = loadRepos();
    const invalidSync = targetLoaded
      ? validateModeSwitchTargetSync(loaded.repoRoot, targetLoaded, journal)
      : "the target manifest could not be loaded";
    if (invalidSync) {
      log.error(`Journal-owned target sync is blocked because ${invalidSync}. Run "oms doctor" before retrying.`);
      return 1;
    }
    let synced: number;
    try {
      if (journal.targetMode === "worktree" && journal.stagedRepositories.length > 0) {
        synced = installStagedWorktreeRepositories(loaded.repoRoot, loaded.repos, journal);
      } else if (journal.targetMode === "submodule" && journal.stagedRepositories.length > 0) {
        installStagedSubmoduleRepositories(loaded.repoRoot, loaded.repos, journal);
        synced = verifySelectedGitlinks(loaded.repoRoot, journal)
          ? 0
          : 1;
      } else {
        synced = await runSync(loaded.repos.map(({ alias }) => alias), {
          all: true,
          commit: false,
          modeSwitchTransitionId: journal.transitionId,
        });
      }
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      synced = 2;
    }
    if (synced !== 0) {
      log.error(`Target-mode sync is incomplete. Retry "oms mode switch ${targetMode} --sync"; do not run standalone sync while ${join(loaded.repoRoot, ".oms-mode-switch.json")} exists.`);
      return synced;
    }
    journal.phase = "target-synced";
    writeModeSwitchJournal(loaded.repoRoot, journal);
  }
  if (journal.phase === "manifest-updated" || journal.phase === "target-synced") {
    const finalized = transitionCommitAlreadySucceeded(loaded.repoRoot, journal, loaded.repos)
      ? 0
      : finalizeRoot(loaded.repoRoot, loaded.repos, targetMode, journal.commit, journal);
    if (finalized !== 0) return finalized;
    modeSwitchCrashHook("mode-switch-after-root-finalize");
    journal.phase = "root-finalized";
    writeModeSwitchJournal(loaded.repoRoot, journal);
  }
  cleanupModeSwitchStaging(loaded.repoRoot, journal.transitionId);
  removeModeSwitchJournal(loaded.repoRoot);
  log.success(`Workspace mode switched to ${targetMode}${sync ? " and target topology was synced" : " without target topology sync"}.`);
  return 0;
}
