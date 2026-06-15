import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DATA_DIRNAME, MANIFEST_FILENAME, MIN_GIT_MAJOR, MIN_GIT_MINOR } from "./constants.js";
import type { GitResult, WorkspaceOptions } from "./types.js";

export function runGit(cwd: string, args: string[], inheritOutput = false): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: inheritOutput ? "inherit" : ["ignore", "pipe", "pipe"],
  });

  return {
    exitCode: result.status,
    success: result.status === 0,
    stdout: inheritOutput ? "" : (result.stdout ?? ""),
  };
}

/** Run git inside the submodule working tree at oms/<alias>/. */
export function runSub(repoRoot: string, alias: string, args: string[], inheritOutput = false): GitResult {
  return runGit(aliasDir(repoRoot, alias), args, inheritOutput);
}

export function parseGitVersion(s: string): { major: number; minor: number } | null {
  const m = s.match(/git version (\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number.parseInt(m[1], 10), minor: Number.parseInt(m[2], 10) };
}

export function isGitVersionSupported(v: { major: number; minor: number }): boolean {
  if (v.major > MIN_GIT_MAJOR) return true;
  if (v.major < MIN_GIT_MAJOR) return false;
  return v.minor >= MIN_GIT_MINOR;
}

export function findWorkspaceRoot(options: WorkspaceOptions = {}): string | null {
  let current = resolve(options.cwd ?? process.cwd());
  while (true) {
    if (existsSync(join(current, MANIFEST_FILENAME))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function aliasDir(repoRoot: string, alias: string): string {
  return join(repoRoot, DATA_DIRNAME, alias);
}

/** Submodule name and path are identical under our convention: oms/<alias>. */
export function submodulePath(alias: string): string {
  return `${DATA_DIRNAME}/${alias}`;
}

export function isGitRepo(repoRoot: string): boolean {
  return runGit(repoRoot, ["rev-parse", "--is-inside-work-tree"]).stdout.trim() === "true";
}

/** Every submodule path registered in .gitmodules (empty when the file is absent or registers none). */
export function registeredSubmodulePaths(repoRoot: string): string[] {
  if (!existsSync(join(repoRoot, ".gitmodules"))) return [];

  const result = runGit(repoRoot, [
    "config",
    "--file",
    ".gitmodules",
    "--get-regexp",
    "^submodule\\..*\\.path$",
  ]);
  if (!result.success) return [];

  return result.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((p): p is string => Boolean(p));
}

/** True when .gitmodules registers a submodule at the given path (sources/<alias> or oms/<alias>). */
export function isRegisteredSubmodule(repoRoot: string, sourcePath: string): boolean {
  return registeredSubmodulePaths(repoRoot).includes(sourcePath);
}

/** True when .gitmodules still registers at least one submodule. */
export function hasRegisteredSubmodules(repoRoot: string): boolean {
  return registeredSubmodulePaths(repoRoot).length > 0;
}

/** A submodule is initialized when its working tree has a .git gitlink file/dir. */
export function submoduleInitialized(repoRoot: string, alias: string): boolean {
  return existsSync(join(aliasDir(repoRoot, alias), ".git"));
}

/** Short branch name, or null when HEAD is detached. */
export function currentBranch(dir: string): string | null {
  const r = runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!r.success) return null;
  const b = r.stdout.trim();
  return b && b !== "HEAD" ? b : null;
}

export function shortSha(dir: string): string {
  const r = runGit(dir, ["rev-parse", "--short", "HEAD"]);
  return r.success ? r.stdout.trim() : "???????";
}

export function localBranchExists(dir: string, branch: string): boolean {
  return runGit(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).success;
}

export function remoteBranchExists(dir: string, branch: string): boolean {
  return runGit(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).success;
}

/** Local branch short names (refs/heads), e.g. ["main", "dev"]. Empty on failure or none. */
export function listLocalBranches(dir: string): string[] {
  const r = runGit(dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  if (!r.success) return [];
  return r.stdout.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Remote branch short names under origin, with the "origin/" prefix stripped and origin/HEAD excluded. */
export function listRemoteBranches(dir: string): string[] {
  const r = runGit(dir, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"]);
  if (!r.success) return [];
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "origin/HEAD")
    .map((s) => (s.startsWith("origin/") ? s.slice("origin/".length) : s))
    .filter((s) => s !== "HEAD");
}

export function isDirty(dir: string): boolean {
  const r = runGit(dir, ["status", "--porcelain"]);
  return r.success && r.stdout.trim().length > 0;
}
