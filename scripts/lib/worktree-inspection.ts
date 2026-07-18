import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { runGit } from "./git.js";
import { submoduleOperationInProgress } from "./status.js";
import {
  commonRepoPath,
  managedWorktreePath,
  validateWorktreeName,
  worktreeAliasPath,
} from "./worktree-paths.js";

export type WorktreeRegistration = {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
};

export type ClassifiedWorktree = WorktreeRegistration & {
  alias: string;
  managed: boolean;
  name: string | null;
  target: string | null;
  stale: boolean;
  safeToPrune: boolean;
  canonicalPath: string | null;
  repairCandidates: string[];
  ownershipError: string | null;
};

export type WorktreeInventory = {
  alias: string;
  commonDir: string;
  worktrees: ClassifiedWorktree[];
};

export type WorktreeState = {
  branch: string | null;
  head: string | null;
  detached: boolean;
  trackingBranch: string | null;
  ahead: number | null;
  behind: number | null;
  changes: { staged: number; unstaged: number; untracked: number };
  dirty: boolean;
  ignored: number;
  nestedRepositories: number;
  operation: string | null;
  recoverable: boolean;
  recoverableRefs: string[];
};

function canonicalExisting(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function hasSymlinkComponent(parent: string, candidate: string): boolean {
  const parentPath = resolve(parent);
  const candidatePath = resolve(candidate);
  const rel = relative(parentPath, candidatePath);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return true;
  let current = parentPath;
  for (const component of rel.split(sep)) {
    current = resolve(current, component);
    if (!existsSync(current)) return false;
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function directManagedName(workspaceRoot: string, alias: string, path: string): string | null {
  const parent = resolve(worktreeAliasPath(workspaceRoot, alias));
  if (resolve(dirname(path)) !== parent) return null;
  const name = basename(path);
  try {
    validateWorktreeName(name);
    return name;
  } catch {
    return null;
  }
}

function commonDirFromWorktree(path: string): string | null {
  const result = runGit(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return result.success ? canonicalExisting(result.stdout.trim()) : null;
}

/** Verify the expected bare common repository and its OMS ownership metadata. */
export function verifyCommonRepository(
  workspaceRoot: string,
  alias: string,
  workspaceId: string,
): string {
  const common = commonRepoPath(workspaceRoot, alias);
  if (!existsSync(common)) throw new Error(`${alias}: common repository is missing`);
  if (hasSymlinkComponent(workspaceRoot, common)) {
    throw new Error(`${alias}: common repository path contains a symbolic link`);
  }
  const entry = lstatSync(common);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`${alias}: common repository path is not a non-symlink directory`);
  }
  const workspace = realpathSync(workspaceRoot);
  const canonical = realpathSync(common);
  const rel = relative(workspace, canonical);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${alias}: common repository resolves outside the workspace`);
  }
  const bare = runGit(common, ["rev-parse", "--is-bare-repository"]);
  const owner = runGit(common, ["config", "--get", "oms.workspaceId"]);
  const configuredAlias = runGit(common, ["config", "--get", "oms.alias"]);
  if (!bare.success || bare.stdout.trim() !== "true"
    || owner.stdout.trim() !== workspaceId || configuredAlias.stdout.trim() !== alias) {
    throw new Error(`${alias}: common repository ownership or shape does not match this workspace`);
  }
  return canonical;
}

/** Parse `git worktree list --porcelain -z` without mutating registrations. */
export function parseWorktreeRegistrations(common: string): WorktreeRegistration[] {
  const result = runGit(common, ["worktree", "list", "--porcelain", "-z"]);
  if (!result.success) throw new Error("Could not inspect Git worktree registrations");
  const entries: WorktreeRegistration[] = [];
  let current: WorktreeRegistration | null = null;
  for (const field of result.stdout.split("\0")) {
    if (!field) continue;
    const [key, ...rest] = field.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") {
      if (current) entries.push(current);
      current = { path: value, head: null, branch: null, bare: false, locked: false, prunable: false };
    } else if (current && key === "HEAD") current.head = value;
    else if (current && key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
    else if (current && key === "bare") current.bare = true;
    else if (current && key === "locked") current.locked = true;
    else if (current && key === "prunable") current.prunable = true;
  }
  if (current) entries.push(current);
  return entries;
}

function repairCandidates(
  workspaceRoot: string,
  alias: string,
  common: string,
  registeredPaths: Set<string>,
): string[] {
  const dataPath = resolve(workspaceRoot, "oms");
  if (!existsSync(dataPath)) return [];
  if (lstatSync(dataPath).isSymbolicLink()) return [dataPath];
  const canonicalCommon = realpathSync(common);
  const candidates: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        candidates.push(path);
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (registeredPaths.has(path)) continue;
      if (commonDirFromWorktree(path) === canonicalCommon) {
        candidates.push(path);
        continue;
      }
      visit(path);
    }
  };
  visit(dataPath);
  return candidates;
}

/** Build an ownership-verified classification of every linked worktree registration. */
export function inspectWorktreeInventory(
  workspaceRoot: string,
  alias: string,
  workspaceId: string,
): WorktreeInventory {
  const common = verifyCommonRepository(workspaceRoot, alias, workspaceId);
  const registrations = parseWorktreeRegistrations(common).filter(({ bare }) => !bare);
  const registeredPaths = new Set(registrations.map(({ path }) => resolve(path)));
  const candidates = repairCandidates(workspaceRoot, alias, common, registeredPaths);
  const worktrees = registrations.map((registration): ClassifiedWorktree => {
    const name = directManagedName(workspaceRoot, alias, registration.path);
    const stale = !existsSync(registration.path);
    const canonicalPath = stale ? null : canonicalExisting(registration.path);
    let ownershipError: string | null = null;
    if (!stale && commonDirFromWorktree(registration.path) !== common) {
      ownershipError = "worktree common directory does not match the owned common repository";
    } else if (name && !stale && hasSymlinkComponent(workspaceRoot, registration.path)) {
      ownershipError = "worktree path contains a symbolic link";
    } else if (name && !stale) {
      const entry = lstatSync(registration.path);
      const expected = managedWorktreePath(workspaceRoot, { alias, name });
      if (entry.isSymbolicLink() || canonicalPath !== canonicalExisting(expected)) {
        ownershipError = "managed path is symbolic or does not match its canonical target";
      }
    }
    const managed = name !== null && ownershipError === null;
    return {
      ...registration,
      alias,
      managed,
      name: managed ? name : null,
      target: managed ? `${alias}/${name}` : null,
      stale,
      safeToPrune: Boolean(managed && stale && registration.prunable && candidates.length === 0),
      canonicalPath,
      repairCandidates: stale ? candidates : [],
      ownershipError,
    };
  });
  return { alias, commonDir: common, worktrees };
}

function parseChanges(path: string): WorktreeState["changes"] {
  const result = runGit(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!result.success) throw new Error("could not inspect worktree changes");
  const counts = { staged: 0, unstaged: 0, untracked: 0 };
  const tokens = result.stdout.split("\0");
  for (let index = 0; index < tokens.length; index++) {
    const value = tokens[index];
    if (!value || value.length < 3) continue;
    const x = value[0];
    const y = value[1];
    if (x === "R" || x === "C") index++;
    if (x === "?" && y === "?") counts.untracked++;
    else {
      if (x !== " " && x !== "?") counts.staged++;
      if (y !== " " && y !== "?") counts.unstaged++;
    }
  }
  return counts;
}

function countNulEntries(path: string, args: string[]): number {
  const result = runGit(path, args);
  if (!result.success) throw new Error(`could not run git ${args.join(" ")}`);
  return result.stdout.split("\0").filter(Boolean).length;
}

function countNestedRepositories(root: string): number {
  let count = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.name === ".git") {
        if (directory !== root) count++;
        continue;
      }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (existsSync(resolve(path, "HEAD"))
          && existsSync(resolve(path, "objects")) && existsSync(resolve(path, "refs"))) {
          count++;
          continue;
        }
        visit(path);
      }
    }
  };
  visit(root);
  return count;
}

/** Inspect safety-relevant state for one existing linked worktree. */
export function inspectWorktreeState(path: string): WorktreeState {
  const branchResult = runGit(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const headResult = runGit(path, ["rev-parse", "--verify", "HEAD"]);
  if (!headResult.success || !/^[0-9a-f]{40,64}$/.test(headResult.stdout.trim())) {
    throw new Error("could not inspect worktree HEAD");
  }
  const branch = branchResult.success ? branchResult.stdout.trim() || null : null;
  const head = headResult.stdout.trim();
  const detached = branch === null && head !== null;
  let trackingBranch: string | null = null;
  if (branch) {
    const upstream = runGit(path, ["for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`]);
    if (!upstream.success) throw new Error("could not inspect worktree upstream");
    trackingBranch = upstream.stdout.trim() || null;
  }
  let ahead: number | null = null;
  let behind: number | null = null;
  if (trackingBranch) {
    const upstreamExists = runGit(path, ["rev-parse", "--verify", "@{u}"]);
    if (upstreamExists.success) {
      const upstreamCommit = runGit(path, ["rev-parse", "--verify", "@{u}^{commit}"]);
      if (!upstreamCommit.success) throw new Error("worktree upstream does not resolve to a commit");
      const divergence = runGit(path, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
      if (!divergence.success) throw new Error("could not inspect worktree tracking divergence");
      const [behindValue, aheadValue] = divergence.stdout.trim().split(/\s+/).map(Number);
      ahead = Number.isFinite(aheadValue) ? aheadValue : null;
      behind = Number.isFinite(behindValue) ? behindValue : null;
    }
  }
  const changes = parseChanges(path);
  const ignored = countNulEntries(path, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]);
  const nestedRepositories = countNestedRepositories(path);
  let recoverableRefs: string[] = [];
  if (detached && head) {
    const refs = runGit(path, ["for-each-ref", "--contains", head, "--format=%(refname)", "refs"]);
    if (!refs.success) throw new Error("could not inspect detached HEAD recoverability");
    recoverableRefs = refs.stdout.split("\n").map((value) => value.trim()).filter((value) =>
      Boolean(value)
      && !value.startsWith("refs/worktree/")
      && !value.startsWith("refs/bisect/")
      && !value.startsWith("refs/rewritten/"));
  }
  return {
    branch,
    head,
    detached,
    trackingBranch,
    ahead,
    behind,
    changes,
    dirty: changes.staged + changes.unstaged + changes.untracked > 0,
    ignored,
    nestedRepositories,
    operation: submoduleOperationInProgress(path),
    recoverable: !detached || recoverableRefs.length > 0,
    recoverableRefs,
  };
}
