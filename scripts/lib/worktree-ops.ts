import { existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";
import { cancel, log } from "@clack/prompts";
import { runGit } from "./git.js";
import { loadForWorktrees } from "./manifest.js";
import { networkFailure, runNetworkGit } from "./network-git.js";
import { guardedSelect, guardedText, isCancel, promptQueueActive } from "./prompt-adapter.js";
import type { Repo } from "./types.js";
import {
  assertGeneratedPathSupported,
  assertNoSymlinkComponents,
  assertUniqueWorktreeName,
  commonRepoPath,
  managedWorktreePath,
  normalizeWorktreeName,
  parseManagedTarget,
  validateWorktreeName,
} from "./worktree-paths.js";
import {
  inspectWorktreeInventory,
  inspectWorktreeState,
  type ClassifiedWorktree,
} from "./worktree-inspection.js";
import { readWorkspaceOwnership } from "./workspace-mutation.js";
import {
  reconcileWorktreeRemotes,
  hasTrustedFetchProvenance,
  recordFetchProvenance,
  resolveWorktreeBaseline,
} from "./worktree-sync.js";

type WorktreeAddOptions = { name?: string; from?: string; remote?: string };

function repoByAlias(repos: Repo[], alias: string): Repo | null {
  const repo = repos.find((candidate) => candidate.alias === alias) ?? null;
  if (!repo) log.error(`Unknown repository alias "${alias}".`);
  return repo;
}

function interactive(): boolean {
  return Boolean(process.stdin.isTTY) || promptQueueActive();
}

async function resolveAddInputs(
  repos: Repo[],
  alias: string | undefined,
  branch: string | undefined,
): Promise<{ alias: string; branch: string } | null> {
  let selectedAlias = alias;
  if (!selectedAlias) {
    if (!interactive()) {
      log.error("worktree add requires a repository alias outside an interactive terminal");
      return null;
    }
    const choice = await guardedSelect<string>({
      message: "Select a repository for the new worktree",
      options: repos.map((repo) => ({ value: repo.alias, label: repo.alias })),
    });
    if (isCancel(choice)) {
      cancel("Worktree creation cancelled.");
      return null;
    }
    selectedAlias = choice;
  }

  let selectedBranch = branch;
  if (!selectedBranch) {
    if (!interactive()) {
      log.error("worktree add requires a branch outside an interactive terminal");
      return null;
    }
    const value = await guardedText({
      message: `${selectedAlias}: enter an existing or new branch name`,
      validate: (input) => (input ?? "").trim().length > 0 ? undefined : "Branch is required.",
    });
    if (isCancel(value)) {
      cancel("Worktree creation cancelled.");
      return null;
    }
    selectedBranch = value.trim();
  }
  return { alias: selectedAlias, branch: selectedBranch };
}

export function fetchSelectedWorktreeRemote(
  workspaceRoot: string,
  common: string,
  repo: Repo,
  remote: string,
  branch: string,
): { ok: boolean; remoteOid: string | null } {
  reconcileWorktreeRemotes(workspaceRoot, common, repo);
  let result;
  try {
    result = runNetworkGit(
      common,
      repo,
      remote,
      (endpoint) => ["fetch", "--atomic", "--prune", endpoint, `+refs/heads/*:refs/remotes/${remote}/*`],
      {
        inheritOutput: true,
        checkFallback: () => hasTrustedFetchProvenance(workspaceRoot, common, repo, remote),
        captureOid: () => {
          const resolved = runGit(common, ["rev-parse", "--verify", `refs/remotes/${remote}/${branch}^{commit}`]);
          const oid = resolved.stdout.trim();
          return resolved.success && /^[0-9a-f]{40,64}$/.test(oid) ? oid : null;
        },
        onSuccess: () => recordFetchProvenance(workspaceRoot, repo, remote),
      },
    );
  } catch (error) {
    networkFailure(repo, remote, error);
    return { ok: false, remoteOid: null };
  }
  if (!result.success) {
    if (result.fallbackTrusted) {
      log.warn(`${repo.alias}: fetch ${remote} failed; using refs from the last verified fetch as stale data`);
      return { ok: true, remoteOid: result.capturedOid };
    }
    return { ok: false, remoteOid: null };
  }
  return { ok: true, remoteOid: result.capturedOid };
}

export async function runWorktreeList(alias?: string): Promise<number> {
  const loaded = loadForWorktrees();
  if (!loaded) return 1;
  const ownership = readWorkspaceOwnership(loaded.repoRoot);
  if (!ownership) {
    log.error("Workspace ownership is missing; run a mutating OMS command before inspecting worktrees.");
    return 1;
  }
  const selected = alias ? [repoByAlias(loaded.repos, alias)].filter((repo): repo is Repo => repo !== null) : loaded.repos;
  if (alias && selected.length === 0) return 1;
  for (const repo of selected) {
    const common = commonRepoPath(loaded.repoRoot, repo.alias);
    if (!existsSync(common)) {
      console.log(`${repo.alias}\t(no common repository)`);
      continue;
    }
    try {
      const linked = inspectWorktreeInventory(loaded.repoRoot, repo.alias, ownership.workspaceId).worktrees;
      if (linked.length === 0) console.log(`${repo.alias}\t(no worktrees)`);
      for (const entry of linked) {
        const flags = [entry.managed ? null : "external", entry.stale ? "stale" : null, entry.locked ? "locked" : null, entry.safeToPrune ? "prunable" : null]
          .filter(Boolean).join(",");
        console.log(`${entry.target ?? `${repo.alias}/(external)`}\t${entry.branch ?? "(detached)"}\t${entry.path}${flags ? `\t${flags}` : ""}`);
      }
    } catch (error) {
      log.error(`${repo.alias}: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }
  return 0;
}

export async function runWorktreeAdd(
  alias: string | undefined,
  branch: string | undefined,
  options: WorktreeAddOptions,
): Promise<number> {
  const loaded = loadForWorktrees();
  if (!loaded) return 1;
  const inputs = await resolveAddInputs(loaded.repos, alias, branch);
  if (!inputs) return 1;
  alias = inputs.alias;
  branch = inputs.branch;
  const repo = repoByAlias(loaded.repos, alias);
  if (!repo) return 1;
  const remote = options.remote ?? "origin";
  if (!(remote in repo.remotes)) {
    log.error(`${alias}: remote "${remote}" is not declared in oms.yaml`);
    return 1;
  }
  const common = commonRepoPath(loaded.repoRoot, alias);
  if (!existsSync(common)) {
    log.error(`${alias}: common repository is missing; run "oms sync ${alias}" first`);
    return 1;
  }
  const ownership = readWorkspaceOwnership(loaded.repoRoot);
  if (!ownership) return 1;
  const entries = inspectWorktreeInventory(loaded.repoRoot, alias, ownership.workspaceId).worktrees;
  const names = entries.map(({ name }) => name).filter((name): name is string => name !== null);
  const name = options.name ?? normalizeWorktreeName(branch);
  try {
    assertUniqueWorktreeName(name, names);
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const target = managedWorktreePath(loaded.repoRoot, { alias, name });
  try {
    assertNoSymlinkComponents(loaded.repoRoot, target);
    assertGeneratedPathSupported(target);
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (existsSync(target)) {
    log.error(`${alias}/${name}: checkout path is occupied`);
    return 1;
  }
  const fetched = fetchSelectedWorktreeRemote(loaded.repoRoot, common, repo, remote, branch);
  if (!fetched.ok) {
    log.error(`${alias}: fetch ${remote} failed; no worktree was created`);
    return 2;
  }
  const checkedOut = entries.find((entry) => entry.branch === branch);
  if (checkedOut) {
    log.error(`${alias}: branch ${branch} is already checked out at ${checkedOut.path}`);
    return 1;
  }

  let branchCreated = false;
  if (!runGit(common, ["rev-parse", "--verify", `refs/heads/${branch}`]).success) {
    if (fetched.remoteOid) {
      if (!runGit(common, ["branch", "--track", branch, `refs/remotes/${remote}/${branch}`]).success) return 2;
    } else {
      const baseline = options.from ?? resolveWorktreeBaseline(loaded.repoRoot, common, repo);
      const start = baseline
        ? [`refs/heads/${baseline}`, `refs/remotes/origin/${baseline}`, baseline]
            .find((ref) => runGit(common, ["rev-parse", "--verify", `${ref}^{commit}`]).success)
        : undefined;
      if (!start) {
        log.error(`${alias}: no valid start point for new branch ${branch}`);
        return 1;
      }
      if (!runGit(common, ["branch", "--no-track", branch, start]).success) return 2;
    }
    branchCreated = true;
  }
  mkdirSync(dirname(target), { recursive: true });
  mkdirSync(target);
  const createdDirectory = lstatSync(target);
  const result = runGit(common, ["worktree", "add", "--relative-paths", target, branch], true);
  if (!result.success) {
    const registered = inspectWorktreeInventory(loaded.repoRoot, alias, ownership.workspaceId).worktrees
      .find((entry) => entry.path === target);
    if (!registered && existsSync(target)) {
      const currentDirectory = lstatSync(target);
      if (currentDirectory.dev === createdDirectory.dev && currentDirectory.ino === createdDirectory.ino
        && currentDirectory.isDirectory() && readdirSync(target).length === 0) {
        rmdirSync(target);
      }
    }
    log.error(
      `${alias}/${name}: creation failed${branchCreated ? `; branch ${branch} was preserved` : ""}. ${registered ? "Run \"oms doctor\" to inspect the retained registration." : `Retry "oms worktree add ${alias} ${branch}${options.name ? ` --name ${name}` : ""}".`}`,
    );
    return 2;
  }
  log.success(`${alias}/${name}: created on ${branch}`);
  return 0;
}

function resolveManagedEntry(workspaceRoot: string, alias: string, name: string): ClassifiedWorktree | null {
  const ownership = readWorkspaceOwnership(workspaceRoot);
  if (!ownership) return null;
  return inspectWorktreeInventory(workspaceRoot, alias, ownership.workspaceId).worktrees
    .find((entry) => entry.managed && entry.name === name) ?? null;
}

function sameRegistration(left: ClassifiedWorktree, right: ClassifiedWorktree): boolean {
  return left.path === right.path && left.head === right.head && left.branch === right.branch
    && left.locked === right.locked && left.stale === right.stale
    && left.canonicalPath === right.canonicalPath && left.ownershipError === right.ownershipError;
}

export async function runWorktreeMove(targetValue: string, newName: string): Promise<number> {
  const loaded = loadForWorktrees();
  if (!loaded) return 1;
  let target;
  try {
    target = parseManagedTarget(targetValue);
    validateWorktreeName(newName);
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (!repoByAlias(loaded.repos, target.alias)) return 1;
  const common = commonRepoPath(loaded.repoRoot, target.alias);
  const entry = resolveManagedEntry(loaded.repoRoot, target.alias, target.name);
  if (!entry || entry.locked) {
    log.error(`${targetValue}: is not an unlocked managed worktree`);
    return 1;
  }
  const operation = inspectWorktreeState(entry.path).operation;
  if (operation) {
    log.error(`${targetValue}: Git operation ${operation} is in progress`);
    return 1;
  }
  const destination = managedWorktreePath(loaded.repoRoot, { alias: target.alias, name: newName });
  try {
    const ownership = readWorkspaceOwnership(loaded.repoRoot);
    if (!ownership) return 1;
    const names = inspectWorktreeInventory(loaded.repoRoot, target.alias, ownership.workspaceId).worktrees
      .filter((candidate) => candidate.path !== entry.path)
      .map(({ name }) => name).filter((name): name is string => name !== null);
    assertUniqueWorktreeName(newName, names);
    assertNoSymlinkComponents(loaded.repoRoot, destination);
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (existsSync(destination)) {
    log.error(`${target.alias}/${newName}: destination is occupied`);
    return 1;
  }
  const boundary = resolveManagedEntry(loaded.repoRoot, target.alias, target.name);
  const ownership = readWorkspaceOwnership(loaded.repoRoot);
  const boundaryNames = ownership
    ? inspectWorktreeInventory(loaded.repoRoot, target.alias, ownership.workspaceId).worktrees
      .filter((candidate) => candidate.path !== entry.path)
      .map(({ name }) => name).filter((name): name is string => name !== null)
    : [];
  let nameAvailable = true;
  try {
    assertUniqueWorktreeName(newName, boundaryNames);
  } catch {
    nameAvailable = false;
  }
  if (!boundary || !sameRegistration(entry, boundary) || !nameAvailable
    || existsSync(destination) || inspectWorktreeState(boundary.path).operation) {
    log.error(`${targetValue}: worktree state changed during move preflight; retry after inspection`);
    return 1;
  }
  const result = runGit(common, ["worktree", "move", boundary.path, destination], true);
  if (!result.success) {
    log.error(`${targetValue}: move failed; inspect "oms worktree list ${target.alias}", then retry or run "oms doctor"`);
    return 2;
  }
  log.success(`${targetValue}: moved to ${target.alias}/${newName}`);
  return 0;
}

export async function runWorktreeRemove(targetValue: string, options: { force?: boolean }): Promise<number> {
  const loaded = loadForWorktrees();
  if (!loaded) return 1;
  let target;
  try {
    target = parseManagedTarget(targetValue);
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (!repoByAlias(loaded.repos, target.alias)) return 1;
  const common = commonRepoPath(loaded.repoRoot, target.alias);
  const entry = resolveManagedEntry(loaded.repoRoot, target.alias, target.name);
  if (!entry) {
    log.error(`${targetValue}: is not a registered managed worktree`);
    return 1;
  }
  if (entry.locked) {
    log.error(`${targetValue}: is locked; unlock it explicitly before removal`);
    return 1;
  }
  if (entry.stale || entry.ownershipError) {
    log.error(`${targetValue}: managed path is stale or has ambiguous ownership; run "oms doctor"`);
    return 1;
  }
  const state = inspectWorktreeState(entry.path);
  const blockers = [
    state.dirty ? `${state.changes.staged} staged, ${state.changes.unstaged} unstaged, ${state.changes.untracked} untracked` : null,
    state.ignored > 0 ? `${state.ignored} ignored` : null,
    state.nestedRepositories > 0 ? `${state.nestedRepositories} nested repositories` : null,
    state.operation ? `${state.operation} in progress` : null,
    state.detached && !state.recoverable ? `detached unpublished HEAD ${state.head}` : null,
  ].filter((value): value is string => value !== null);
  if (blockers.length > 0 && !options.force) {
    log.error(`${targetValue}: local state would be discarded (${blockers.join(", ")}); retry with --force after review`);
    return 1;
  }
  if (options.force && blockers.length > 0) log.warn(`${targetValue}: forcing removal of ${blockers.join(", ")}`);
  const boundary = resolveManagedEntry(loaded.repoRoot, target.alias, target.name);
  if (!boundary || !sameRegistration(entry, boundary)) {
    log.error(`${targetValue}: worktree registration changed during removal preflight; retry after inspection`);
    return 1;
  }
  const boundaryState = inspectWorktreeState(boundary.path);
  if (JSON.stringify(boundaryState) !== JSON.stringify(state)) {
    log.error(`${targetValue}: worktree safety state changed during removal preflight; retry after inspection`);
    return 1;
  }
  const result = runGit(common, ["worktree", "remove", ...(options.force ? ["--force"] : []), boundary.path], true);
  if (!result.success) {
    log.error(`${targetValue}: removal failed; the branch was preserved. Inspect "oms worktree list ${target.alias}", then retry or run "oms doctor".`);
    return 2;
  }
  log.success(`${targetValue}: removed; local branch ${entry.branch ?? "(detached)"} was preserved`);
  return 0;
}
