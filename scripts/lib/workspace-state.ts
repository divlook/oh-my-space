import { existsSync, lstatSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { DATA_DIRNAME } from "./constants.js";
import { normalizePath } from "./env.js";
import { aliasDir, isRegisteredSubmodule, runGit, submoduleInitialized, submodulePath } from "./git.js";
import { gitOperationInProgress } from "./git-operation-state.js";
import type { Repo } from "./types.js";
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

export type PinValue = "ok" | "moved" | "uninit" | "missing" | "conflict";

export type GitlinkState = {
  alias: string;
  /** Root HEAD recorded gitlink OID, or null when HEAD records no gitlink for the path. */
  headOid: string | null;
  indexOid: string | null;
  /** Submodule working tree HEAD OID, or null when uninitialized or the path was removed. */
  worktreeOid: string | null;
  conflict: boolean;
  initialized: boolean;
  pathExists: boolean;
  gitmodulesEntry: boolean;
  moved: boolean;
  staged: boolean;
  split: boolean;
  pin: PinValue;
};

type RootGitlink = Pick<GitlinkState, "headOid" | "indexOid" | "conflict">;
export type GitlinkObservation = Omit<GitlinkState, "gitmodulesEntry">;

function headGitlinkOid(repoRoot: string, alias: string): string | null {
  const r = runGit(repoRoot, ["ls-tree", "HEAD", "--", submodulePath(alias)]);
  if (!r.success) return null;
  const m = r.stdout.match(/^160000 commit ([0-9a-f]+)\t/m);
  return m ? m[1] : null;
}

function indexGitlinkOid(repoRoot: string, alias: string): string | null {
  const r = runGit(repoRoot, ["ls-files", "--stage", "--", submodulePath(alias)]);
  if (!r.success) return null;
  const m = r.stdout.match(/^160000 ([0-9a-f]+) 0\t/m);
  return m ? m[1] : null;
}

function gitlinkConflicted(repoRoot: string, alias: string): boolean {
  const r = runGit(repoRoot, ["ls-files", "-u", "--", submodulePath(alias)]);
  return r.success && r.stdout.trim().length > 0;
}

function readGitlinkRecords(
  repoRoot: string,
  args: string[],
  visit: (header: string, path: string) => boolean,
): boolean {
  const { success, stdout } = runGit(repoRoot, args);
  if (!success) return false;
  // Parse only complete NUL-delimited records. Paths can themselves contain tabs or newlines.
  for (let start = 0; start < stdout.length;) {
    const end = stdout.indexOf("\0", start);
    const separator = stdout.indexOf("\t", start);
    if (end < 0 || separator < 0 || separator >= end || separator + 1 === end) return false;
    if (!visit(stdout.slice(start, separator), stdout.slice(separator + 1, end))) return false;
    start = end + 1;
  }
  return true;
}

/** Read the selected status pointers without inspecting `.gitmodules` or unrelated aliases. */
export function observeGitlinks(repoRoot: string, aliases: readonly string[]): GitlinkObservation[] {
  if (aliases.length === 0) return [];
  const paths = aliases.map(submodulePath);
  const pointers = new Map<string, RootGitlink>(
    paths.map((path) => [path, { headOid: null, indexOid: null, conflict: false }]),
  );
  const headRead = readGitlinkRecords(repoRoot, ["ls-tree", "-z", "HEAD", "--", ...paths], (header, path) => {
    const entry = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]+)$/.exec(header);
    if (!entry) return false;
    const pointer = pointers.get(path);
    if (pointer && entry[1] === "160000" && entry[2] === "commit") pointer.headOid = entry[3];
    return true;
  });
  const indexRead = readGitlinkRecords(repoRoot, ["ls-files", "--stage", "-z", "--", ...paths], (header, path) => {
    const entry = /^([0-7]{6}) ([0-9a-f]+) ([0-3])$/.exec(header);
    if (!entry) return false;
    // A selected directory pathspec also matches its descendants, just like the singular query.
    const child = path.indexOf("/", DATA_DIRNAME.length + 1);
    const pointer = pointers.get(child < 0 ? path : path.slice(0, child));
    if (pointer) {
      if (entry[3] !== "0") pointer.conflict = true;
      else if (entry[1] === "160000") pointer.indexOid ??= entry[2];
    }
    return true;
  });

  return aliases.map((alias, index) => {
    const pointer = pointers.get(paths[index])!;
    // Retry only the failed observation. An unreadable path or oversized batch must not hide
    // healthy aliases, and a failed stage read must not erase a successful conflict read.
    if (!headRead) pointer.headOid = headGitlinkOid(repoRoot, alias);
    if (!indexRead) {
      pointer.indexOid = indexGitlinkOid(repoRoot, alias);
      pointer.conflict = gitlinkConflicted(repoRoot, alias);
    }
    return completeGitlinkObservation(repoRoot, alias, pointer);
  });
}

export function gitlinkState(repoRoot: string, alias: string): GitlinkState {
  const pointer = {
    headOid: headGitlinkOid(repoRoot, alias),
    indexOid: indexGitlinkOid(repoRoot, alias),
    conflict: gitlinkConflicted(repoRoot, alias),
    gitmodulesEntry: isRegisteredSubmodule(repoRoot, submodulePath(alias)),
  };
  return completeGitlinkObservation(repoRoot, alias, pointer);
}

function completeGitlinkObservation<T extends RootGitlink>(
  repoRoot: string,
  alias: string,
  pointer: T,
): GitlinkObservation & T {
  const { headOid, indexOid, conflict } = pointer;
  const dir = aliasDir(repoRoot, alias);
  const initialized = submoduleInitialized(repoRoot, alias);
  const pathExists = existsSync(dir);
  const worktreeOid = initialized
    ? runGit(dir, ["rev-parse", "HEAD"]).stdout.trim() || null
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
    ...pointer,
    alias,
    worktreeOid,
    initialized,
    pathExists,
    moved,
    staged,
    split,
    pin,
  };
}

export function pendingAddTopology(s: GitlinkState): boolean {
  return s.headOid === null && s.initialized && s.gitmodulesEntry;
}

/**
 * Why one alias can or cannot have its root pointer recorded right now. A `benign` verdict is a normal
 * no-op (the pointer simply has not moved); a `problem` verdict needs user action first.
 */
type RecordVerdict =
  | { kind: "recordable" }
  | { kind: "benign"; message: string }
  | { kind: "problem"; message: string };

/**
 * Classify one alias's recordability from its root gitlink state. This is the single source of truth for
 * "can record now": `oms record` enforces it, and the interactive record picker derives its candidates
 * from it so the picker cannot offer an alias that recording would then refuse.
 *
 * Conflicts are deliberately out of scope here — `record` treats a conflicted gitlink as a root-wide
 * abort before any per-alias verdict, and `pin` already reports `conflict` for candidate filtering.
 * @param state - the alias's current root gitlink state
 * @param alias - the alias being classified
 * @returns whether the alias can be recorded, or why it cannot
 */
export function recordVerdict(state: GitlinkState, alias: string): RecordVerdict {
  if (state.headOid === null) {
    const topology = pendingAddTopology(state)
      ? ` Create the initial topology commit with "oms sync ${alias} --commit".`
      : "";
    return {
      kind: "problem",
      message: `${alias}: the root HEAD has no recorded gitlink. "oms record" only updates existing root gitlinks.${topology}`,
    };
  }
  if (!state.pathExists) {
    return {
      kind: "problem",
      message: `${alias}: pending submodule removal. Record the removal with "oms unsync ${alias} --commit".`,
    };
  }
  if (state.split) {
    return {
      kind: "problem",
      message: `${alias}: the staged oms/${alias} pointer differs from the working tree. Unstage or restage oms/${alias}, then retry.`,
    };
  }
  if (state.worktreeOid === null || state.worktreeOid === state.headOid) {
    return { kind: "benign", message: `Nothing to record for ${alias}.` };
  }
  return { kind: "recordable" };
}

export function pendingRemovalTopology(s: GitlinkState): boolean {
  return s.headOid !== null && !s.pathExists && !s.gitmodulesEntry;
}

export function partialRemovalTopology(s: GitlinkState): boolean {
  return s.headOid !== null && !s.pathExists !== !s.gitmodulesEntry;
}

export type AliasDirEntries =
  | { exists: false }
  | { exists: true; kind: "dir"; entries: string[] }
  | { exists: true; kind: "file" }
  | { exists: true; kind: "unreadable" };

/**
 * Inspect oms/<alias> without throwing: distinguishes "absent", "non-directory file", "unreadable"
 * (permission or I/O error), and "readable directory" so callers can refuse before destructive
 * Git/filesystem calls and report the precise cause.
 */
export function readAliasDirEntries(repoRoot: string, alias: string): AliasDirEntries {
  const dir = aliasDir(repoRoot, alias);
  try {
    if (!lstatSync(dir).isDirectory()) return { exists: true, kind: "file" };
    return { exists: true, kind: "dir", entries: readdirSync(dir) };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { exists: false };
    }
    // Non-ENOENT errors (EACCES, EPERM, EBUSY, ...) mean the path exists but cannot be read; surface
    // this distinctly so callers report an access problem instead of a stray non-submodule path.
    return { exists: true, kind: "unreadable" };
  }
}

type RootTopologySafety = { safe: true } | { safe: false; reason: string };

export function unreadablePathReason(alias: string): string {
  return `oms/${alias} could not be read (permission or I/O error). Resolve access to it, then retry.`;
}

const TOPOLOGY_REASON = {
  conflict: "the root gitlink is conflicted. Resolve the root repository conflict first.",
  inProgressOp: (op: string) =>
    `the root repository has a ${op} in progress. Resolve, continue, or abort it first.`,
  occupiedPath: (alias: string) =>
    `oms/${alias} is occupied by a non-submodule path. Move or remove it manually, then retry.`,
  unreadable: (alias: string) => unreadablePathReason(alias),
} as const;

type OccupiedPathState = "clear" | "occupied" | "unreadable";

function occupiedByNonSubmodule(repoRoot: string, alias: string): OccupiedPathState {
  if (isRegisteredSubmodule(repoRoot, submodulePath(alias))) return "clear";
  const dirState = readAliasDirEntries(repoRoot, alias);
  if (!dirState.exists) return "clear";
  if (dirState.kind === "unreadable") return "unreadable";
  if (dirState.kind === "file") return "occupied";
  return dirState.entries.length > 0 ? "occupied" : "clear";
}

export function assertRootWriteSafe(repoRoot: string, alias: string): RootTopologySafety {
  if (gitlinkConflicted(repoRoot, alias)) {
    return { safe: false, reason: TOPOLOGY_REASON.conflict };
  }
  const op = gitOperationInProgress(repoRoot);
  if (op) return { safe: false, reason: TOPOLOGY_REASON.inProgressOp(op) };
  return { safe: true };
}

export function assertRootTopologySafe(repoRoot: string, alias: string): RootTopologySafety {
  const root = assertRootWriteSafe(repoRoot, alias);
  if (!root.safe) return root;
  const occupied = occupiedByNonSubmodule(repoRoot, alias);
  if (occupied === "unreadable") return { safe: false, reason: TOPOLOGY_REASON.unreadable(alias) };
  if (occupied === "occupied") return { safe: false, reason: TOPOLOGY_REASON.occupiedPath(alias) };
  return { safe: true };
}

export function rootFollowupAction(s: GitlinkState): "record" | "sync" | null {
  if (s.headOid !== null && s.pathExists && !s.conflict && s.moved) return "record";
  return pendingAddTopology(s) ? "sync" : null;
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
