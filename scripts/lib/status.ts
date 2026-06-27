import { existsSync, lstatSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { log } from "@clack/prompts";
import { DATA_DIRNAME } from "./constants.js";
import { dim, normalizePath, pad, readPackageVersion, uniqueAliases } from "./env.js";
import {
  aliasDir,
  currentBranch,
  isDirty,
  isRegisteredSubmodule,
  registeredSubmodulePaths,
  runGit,
  shortSha,
  submoduleInitialized,
  submodulePath,
} from "./git.js";
import { loadForSubmodules } from "./manifest.js";
import type { Repo, StatusOptions } from "./types.js";

type StatusRow = {
  alias: string;
  branch: string;
  pin: string;
  dirty: string;
  ahead: string;
  behind: string;
};

/** Parse the leading status char from `git submodule status` (' ' ok, '+' moved, '-' uninit, 'U' conflict). */
export function pinState(repoRoot: string, alias: string): string {
  const r = runGit(repoRoot, ["submodule", "status", "--", submodulePath(alias)]);
  if (!r.success || r.stdout.length === 0) return "?";
  const c = r.stdout[0];
  if (c === " ") return "ok";
  if (c === "+") return "moved";
  if (c === "-") return "uninit";
  if (c === "U") return "conflict";
  return "?";
}

function aheadBehind(dir: string): { ahead: string; behind: string } {
  const r = runGit(dir, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
  if (!r.success) return { ahead: "", behind: "" };
  const [behind, ahead] = r.stdout.trim().split(/\s+/);
  return { ahead: ahead && ahead !== "0" ? ahead : "", behind: behind && behind !== "0" ? behind : "" };
}

// ─── Git state inspection: the shared spine for status JSON, commit, record, sync/unsync, pull/push ───

/** Short HEAD SHA, or null when it cannot be read (unlike shortSha, which returns a sentinel). */
export function headShortSha(dir: string): string | null {
  const r = runGit(dir, ["rev-parse", "--short", "HEAD"]);
  return r.success ? r.stdout.trim() || null : null;
}

type HeadState = { branch: string | null; head: string | null; detached: boolean };

/** Branch/head/detached snapshot. branch is null when detached or unborn; detached implies a real HEAD commit. */
function headState(dir: string): HeadState {
  const branch = currentBranch(dir);
  const head = headShortSha(dir);
  return { branch, head, detached: branch === null && head !== null };
}

type TrackingState = { trackingBranch: string | null; ahead: number | null; behind: number | null };

/** Upstream divergence as numbers; all null when there is no tracking branch or it cannot be compared. */
function trackingState(dir: string): TrackingState {
  const up = runGit(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const trackingBranch = up.success ? up.stdout.trim() || null : null;
  if (!trackingBranch) return { trackingBranch: null, ahead: null, behind: null };
  const r = runGit(dir, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
  if (!r.success) return { trackingBranch, ahead: null, behind: null };
  const [behind, ahead] = r.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
  return {
    trackingBranch,
    ahead: Number.isNaN(ahead) ? null : ahead,
    behind: Number.isNaN(behind) ? null : behind,
  };
}

export type ChangeCounts = { staged: number; unstaged: number; untracked: number };

/**
 * Count changed paths from `git status --porcelain=v1 -z`. A staged rename/copy entry consumes the
 * following NUL token (its source path) and counts once. Paths in excludePaths (submodule gitlinks)
 * are skipped so root counts exclude submodule pointers. Returns zero counts on failure.
 */
export function changeCounts(dir: string, excludePaths: Set<string>): ChangeCounts {
  const counts: ChangeCounts = { staged: 0, unstaged: 0, untracked: 0 };
  const r = runGit(dir, ["status", "--porcelain=v1", "-z"]);
  if (!r.success) return counts;
  const tokens = r.stdout.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry || entry.length < 3) continue;
    const x = entry[0];
    const y = entry[1];
    const path = entry.slice(3);
    // A staged rename/copy emits "<XY> <dest>\0<src>\0"; consume the trailing source token.
    if (x === "R" || x === "C") i++;
    if (excludePaths.has(path)) continue;
    if (x === "?" && y === "?") {
      counts.untracked++;
      continue;
    }
    if (x !== " " && x !== "?") counts.staged++;
    if (y !== " " && y !== "?") counts.unstaged++;
  }
  return counts;
}

export function isDirtyCounts(c: ChangeCounts): boolean {
  return c.staged > 0 || c.unstaged > 0 || c.untracked > 0;
}

/** Name of an in-progress Git operation (merge/rebase/cherry-pick/revert/bisect) in dir, or null when idle. */
export function gitOperationInProgress(dir: string): string | null {
  const markers: Array<[string, string]> = [
    ["MERGE_HEAD", "merge"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["BISECT_LOG", "bisect"],
  ];
  for (const [name, label] of markers) {
    const p = runGit(dir, ["rev-parse", "--git-path", name]);
    if (!p.success) continue;
    if (existsSync(resolve(dir, p.stdout.trim()))) return label;
  }
  return null;
}

export type PinValue = "ok" | "moved" | "uninit" | "missing" | "conflict";

export type GitlinkState = {
  alias: string;
  /** Root HEAD recorded gitlink OID, or null when HEAD records no gitlink for the path. */
  headOid: string | null;
  /** Root index gitlink OID at stage 0, or null when absent or conflicted. */
  indexOid: string | null;
  /** Submodule working tree HEAD OID, or null when uninitialized or the path was removed. */
  worktreeOid: string | null;
  /** Root index has unmerged stages for the path. */
  conflict: boolean;
  /** Submodule working tree is initialized (has a .git gitlink). */
  initialized: boolean;
  /** The oms/<alias> working tree path exists. */
  pathExists: boolean;
  /** .gitmodules registers oms/<alias>. */
  gitmodulesEntry: boolean;
  moved: boolean;
  staged: boolean;
  split: boolean;
  pin: PinValue;
};

/** Root HEAD gitlink OID for oms/<alias>, or null when HEAD records no gitlink there. */
function headGitlinkOid(repoRoot: string, alias: string): string | null {
  const r = runGit(repoRoot, ["ls-tree", "HEAD", "--", submodulePath(alias)]);
  if (!r.success) return null;
  const m = r.stdout.match(/^160000 commit ([0-9a-f]+)\t/m);
  return m ? m[1] : null;
}

/** Root index gitlink OID at stage 0 for oms/<alias>, or null when absent or conflicted. */
function indexGitlinkOid(repoRoot: string, alias: string): string | null {
  const r = runGit(repoRoot, ["ls-files", "--stage", "--", submodulePath(alias)]);
  if (!r.success) return null;
  const m = r.stdout.match(/^160000 ([0-9a-f]+) 0\t/m);
  return m ? m[1] : null;
}

/** True when the root index has unmerged (conflicted) entries for oms/<alias>. */
function gitlinkConflicted(repoRoot: string, alias: string): boolean {
  const r = runGit(repoRoot, ["ls-files", "-u", "--", submodulePath(alias)]);
  return r.success && r.stdout.trim().length > 0;
}

/**
 * Classify a submodule's root pointer state from HEAD/index/worktree OIDs — the shared spine reused by
 * status JSON, commit/record preconditions, sync/unsync topology, and pull/push follow-up hints.
 */
export function gitlinkState(repoRoot: string, alias: string): GitlinkState {
  const headOid = headGitlinkOid(repoRoot, alias);
  const indexOid = indexGitlinkOid(repoRoot, alias);
  const conflict = gitlinkConflicted(repoRoot, alias);
  const initialized = submoduleInitialized(repoRoot, alias);
  const pathExists = existsSync(aliasDir(repoRoot, alias));
  const gitmodulesEntry = isRegisteredSubmodule(repoRoot, submodulePath(alias));
  const worktreeOid = initialized
    ? runGit(aliasDir(repoRoot, alias), ["rev-parse", "HEAD"]).stdout.trim() || null
    : null;

  const moved =
    headOid !== null
    && (!pathExists
      || (indexOid !== null && indexOid !== headOid)
      || (worktreeOid !== null && worktreeOid !== headOid));
  const staged = headOid !== null && indexOid !== null && indexOid !== headOid;
  const split = staged && worktreeOid !== null && indexOid !== worktreeOid;

  let pin: PinValue;
  if (conflict) pin = "conflict";
  else if (headOid === null) pin = "missing";
  else if (!initialized) pin = "uninit";
  else if (moved) pin = "moved";
  else pin = "ok";

  return {
    alias,
    headOid,
    indexOid,
    worktreeOid,
    conflict,
    initialized,
    pathExists,
    gitmodulesEntry,
    moved,
    staged,
    split,
    pin,
  };
}

/** Root HEAD has no gitlink, the working tree has an initialized submodule, and .gitmodules registers it. */
export function pendingAddTopology(s: GitlinkState): boolean {
  return s.headOid === null && s.initialized && s.gitmodulesEntry;
}

/** Root HEAD has a gitlink but both the working tree path and the .gitmodules entry are gone. */
export function pendingRemovalTopology(s: GitlinkState): boolean {
  return s.headOid !== null && !s.pathExists && !s.gitmodulesEntry;
}

/** Root HEAD has a gitlink and exactly one of the working tree path or .gitmodules entry is gone. */
export function partialRemovalTopology(s: GitlinkState): boolean {
  return s.headOid !== null && !s.pathExists !== !s.gitmodulesEntry;
}

/** Whether oms/<alias> is absent, a non-directory file, or a readable directory (with its entries). */
export type AliasDirEntries =
  | { exists: false }
  | { exists: true; entries: string[] | null };

/**
 * Inspect oms/<alias> without throwing: distinguishes "absent" from "occupied by a non-submodule
 * file/dir" so callers can refuse before destructive Git/filesystem calls. `entries === null` means
 * the path exists but is a non-directory file or could not be read.
 */
export function readAliasDirEntries(repoRoot: string, alias: string): AliasDirEntries {
  const dir = aliasDir(repoRoot, alias);
  try {
    if (!lstatSync(dir).isDirectory()) return { exists: true, entries: null };
    return { exists: true, entries: readdirSync(dir) };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { exists: false };
    }
    return { exists: true, entries: null };
  }
}

/** The single check applied to a selected alias's root topology before a mutating command runs. */
export type RootTopologyCheck = "conflict" | "inProgressOp" | "occupiedPath";

/** Result of a root-topology preflight: safe to mutate, or a deterministic human-readable reason. */
export type RootTopologySafety = { safe: true } | { safe: false; reason: string };

/** Centralized refusal reasons so messages stay consistent across the routed callers. */
const TOPOLOGY_REASON = {
  conflict: "the root gitlink is conflicted. Resolve the root repository conflict first.",
  inProgressOp: (op: string) =>
    `the root repository has a ${op} in progress. Resolve, continue, or abort it first.`,
  occupiedPath: (alias: string) =>
    `oms/${alias} is occupied by a non-submodule path. Move or remove it manually, then retry.`,
} as const;

/** oms/<alias> is occupied by non-submodule content while not being a registered submodule. */
function occupiedByNonSubmodule(repoRoot: string, alias: string): boolean {
  if (isRegisteredSubmodule(repoRoot, submodulePath(alias))) return false;
  const dirState = readAliasDirEntries(repoRoot, alias);
  return dirState.exists && (dirState.entries === null || dirState.entries.length > 0);
}

/**
 * Whether the selected alias's root topology can be mutated safely.
 * Callers pass the checks that apply to them; checks are always evaluated
 * in the fixed order conflict → inProgressOp → occupiedPath and the first
 * failing applied check determines the returned reason.
 */
export function assertRootTopologySafe(
  repoRoot: string,
  alias: string,
  checks: RootTopologyCheck[] = ["conflict", "inProgressOp", "occupiedPath"],
): RootTopologySafety {
  const applies = new Set(checks);
  if (applies.has("conflict") && gitlinkState(repoRoot, alias).conflict) {
    return { safe: false, reason: TOPOLOGY_REASON.conflict };
  }
  if (applies.has("inProgressOp")) {
    const op = gitOperationInProgress(repoRoot);
    if (op) return { safe: false, reason: TOPOLOGY_REASON.inProgressOp(op) };
  }
  if (applies.has("occupiedPath") && occupiedByNonSubmodule(repoRoot, alias)) {
    return { safe: false, reason: TOPOLOGY_REASON.occupiedPath(alias) };
  }
  return { safe: true };
}

/**
 * The consistent root follow-up hint after a successful commit/pull/push: record an existing moved
 * pointer, create the topology commit for a pending add, or nothing. Never points at `oms record`
 * when record would reject the state (missing recorded gitlink, conflict, or pending removal).
 */
export function rootFollowupHint(alias: string, s: GitlinkState): string | null {
  if (s.headOid !== null && s.pathExists && !s.conflict && s.moved) {
    return `Run "oms record ${alias}" to record the root pointer update.`;
  }
  if (pendingAddTopology(s)) {
    return `Run "oms sync ${alias} --commit" to create the topology commit.`;
  }
  return null;
}

/**
 * Infer the alias when the current directory is inside a configured oms/<alias>/ subtree. Matching is
 * path-segment based, so oms/api-extra never resolves to alias api. Inference succeeds even when the
 * submodule is uninitialized; the calling command enforces its own preconditions afterward.
 */
export function inferAliasFromCwd(repoRoot: string, repos: Repo[], cwd: string = process.cwd()): string | null {
  const rel = relative(repoRoot, resolve(cwd));
  if (rel.startsWith("..")) return null;
  const parts = normalizePath(rel).split("/").filter(Boolean);
  if (parts.length >= 2 && parts[0] === DATA_DIRNAME) {
    const candidate = parts[1];
    if (repos.some((r) => r.alias === candidate)) return candidate;
  }
  return null;
}

/** Machine-readable per-repo status entry. The stable schemaVersion 1 contract is specified by the ai-submodule-workflow capability and summarized by oms status --help. */
type JsonRepoStatus = {
  alias: string;
  path: string;
  absolutePath: string;
  configured: boolean;
  initialized: boolean;
  branch: string | null;
  head: string | null;
  detached: boolean;
  trackingBranch: string | null;
  pin: PinValue;
  dirty: boolean;
  changes: ChangeCounts;
  ahead: number | null;
  behind: number | null;
  error: string | null;
};

type JsonRootStatus = {
  branch: string | null;
  head: string | null;
  detached: boolean;
  dirty: boolean;
  changes: ChangeCounts;
  submodulePointers: {
    moved: string[];
    staged: string[];
    split: string[];
    conflict: string[];
  };
};

type JsonStatus = {
  schemaVersion: 1;
  toolVersion: string;
  workspaceRoot: string;
  currentAlias: string | null;
  root: JsonRootStatus;
  repos: JsonRepoStatus[];
  errors: string[];
};

/**
 * Build one repo's JSON status. Never throws: an initialized repo whose HEAD cannot be read keeps the
 * normal entry shape with null scalars, safe-default structured fields, and a concise `error` message.
 */
function buildRepoStatus(repoRoot: string, repo: Repo): JsonRepoStatus {
  const state = gitlinkState(repoRoot, repo.alias);
  const common = {
    alias: repo.alias,
    path: submodulePath(repo.alias),
    absolutePath: aliasDir(repoRoot, repo.alias),
    configured: true,
    pin: state.pin,
  };
  const safeDefaults = {
    branch: null,
    head: null,
    detached: false,
    trackingBranch: null,
    dirty: false,
    changes: { staged: 0, unstaged: 0, untracked: 0 },
    ahead: null,
    behind: null,
  };
  if (!state.initialized) {
    return { ...common, initialized: false, ...safeDefaults, error: null };
  }
  const dir = aliasDir(repoRoot, repo.alias);
  const head = headShortSha(dir);
  if (head === null) {
    return {
      ...common,
      initialized: true,
      ...safeDefaults,
      error: `${repo.alias}: could not read submodule HEAD`,
    };
  }
  const branch = currentBranch(dir);
  const { trackingBranch, ahead, behind } = trackingState(dir);
  const changes = changeCounts(dir, new Set());
  return {
    ...common,
    initialized: true,
    branch,
    head,
    detached: branch === null,
    trackingBranch,
    dirty: isDirtyCounts(changes),
    changes,
    ahead,
    behind,
    error: null,
  };
}

/**
 * Build the root JSON status. root.changes always excludes every configured submodule gitlink path so
 * pointer movement is reported only through submodulePointers, whose arrays cover the selected repos.
 */
function buildRootStatus(repoRoot: string, configuredRepos: Repo[], selectedRepos: Repo[]): JsonRootStatus {
  const { branch, head, detached } = headState(repoRoot);
  const excludePaths = new Set<string>([
    ...registeredSubmodulePaths(repoRoot),
    ...configuredRepos.map((r) => submodulePath(r.alias)),
  ]);
  const changes = changeCounts(repoRoot, excludePaths);
  const pointers = { moved: [] as string[], staged: [] as string[], split: [] as string[], conflict: [] as string[] };
  for (const repo of selectedRepos) {
    const s = gitlinkState(repoRoot, repo.alias);
    if (s.conflict) pointers.conflict.push(repo.alias);
    if (s.moved) pointers.moved.push(repo.alias);
    if (s.staged) pointers.staged.push(repo.alias);
    if (s.split) pointers.split.push(repo.alias);
  }
  return { branch, head, detached, dirty: isDirtyCounts(changes), changes, submodulePointers: pointers };
}

/** Emit exactly one two-space pretty JSON object on stdout. Exits non-zero if any repo read failed. */
function printStatusJson(repoRoot: string, configuredRepos: Repo[], selectedRepos: Repo[]): number {
  const repos = selectedRepos.map((repo) => buildRepoStatus(repoRoot, repo));
  const errors = repos.filter((r) => r.error !== null).map((r) => r.error as string);
  const payload: JsonStatus = {
    schemaVersion: 1,
    toolVersion: readPackageVersion(),
    workspaceRoot: repoRoot,
    currentAlias: inferAliasFromCwd(repoRoot, configuredRepos),
    root: buildRootStatus(repoRoot, configuredRepos, selectedRepos),
    repos,
    errors,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return errors.length > 0 ? 2 : 0;
}

export async function runStatus(aliases: string[], options: StatusOptions): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  let selected: Repo[];
  if (options.all || aliases.length === 0) {
    selected = repos;
  } else {
    const unknown = aliases.filter((a) => !repos.some((r) => r.alias === a));
    if (unknown.length > 0) {
      const msg = `Unknown alias(es): ${unknown.join(", ")}. Use "oms sync --list" to see available aliases.`;
      if (options.json) process.stderr.write(`${msg}\n`);
      else log.error(msg);
      return 1;
    }
    const byAlias = new Map(repos.map((r) => [r.alias, r]));
    selected = uniqueAliases(aliases).map((a) => byAlias.get(a)!);
  }

  if (options.json) {
    return printStatusJson(repoRoot, repos, selected);
  }

  const rows: StatusRow[] = [];
  for (const repo of selected) {
    const state = gitlinkState(repoRoot, repo.alias);
    if (!state.initialized) {
      rows.push({ alias: repo.alias, branch: "(not synced)", pin: state.pin, dirty: "", ahead: "", behind: "" });
      continue;
    }
    const dir = aliasDir(repoRoot, repo.alias);
    const branch = currentBranch(dir) ?? `(detached ${shortSha(dir)})`;
    const { ahead, behind } = aheadBehind(dir);
    rows.push({
      alias: repo.alias,
      branch,
      pin: state.pin,
      dirty: isDirty(dir) ? "yes" : "",
      ahead,
      behind,
    });
  }

  const col = (key: keyof StatusRow, header: string) =>
    Math.max(header.length, ...rows.map((r) => r[key].length));
  const aW = col("alias", "ALIAS");
  const bW = col("branch", "BRANCH");
  const pW = col("pin", "PIN");
  const dW = Math.max("DIRTY".length, ...rows.map((r) => r.dirty.length));
  console.log(
    dim(
      `${pad("ALIAS", aW)}  ${pad("BRANCH", bW)}  ${pad("PIN", pW)}  ${pad("DIRTY", dW)}  AHEAD  BEHIND`,
    ),
  );
  for (const r of rows) {
    console.log(
      `${pad(r.alias, aW)}  ${pad(r.branch, bW)}  ${pad(r.pin, pW)}  ${pad(r.dirty, dW)}  ${pad(r.ahead, 5)}  ${r.behind}`,
    );
  }
  return 0;
}

/** Print the consistent root follow-up hint (record / topology commit) for the current pointer state. */
export function printRootFollowup(repoRoot: string, alias: string): void {
  const hint = rootFollowupHint(alias, gitlinkState(repoRoot, alias));
  if (hint) log.info(hint);
}
