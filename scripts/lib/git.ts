import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIRNAME, MIN_GIT_MAJOR, MIN_GIT_MINOR } from "./constants.js";
import type { GitResult } from "./types.js";
export type RawGitRunner = (cwd: string, args: string[], input?: Buffer | null) => GitResult;

function environmentGitRunner(env?: NodeJS.ProcessEnv): RawGitRunner {
  return (cwd, args, input) => {
    const result = spawnSync("git", args, {
      cwd,
      env,
      encoding: "buffer",
      ...(input === null ? { stdio: ["inherit", "pipe", "pipe"] } : { input }),
    });
    return {
      exitCode: result.status,
      success: result.status === 0,
      stdout: result.stdout ? result.stdout.toString("utf8") : "",
      stderr: result.stderr ? result.stderr.toString("utf8") : "",
    };
  };
}

export const productionGitRunner: RawGitRunner = environmentGitRunner();

export const redactingGitRunner: RawGitRunner = (cwd, args, input) => {
  const result = productionGitRunner(cwd, args, input);
  return input === null
    ? { ...result, stdout: redactSensitiveUrls(result.stdout), stderr: redactSensitiveUrls(result.stderr) }
    : result;
};

export function redactSensitiveUrls(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[redacted]@")
    .replace(/([?&](?:(?:access|auth|bearer|id|oauth|refresh)?[_-]?token|(?:api|private)?[_-]?key|auth(?:orization)?|(?:client|consumer)?[_-]?secret|credential|jwt|pass(?:word|wd)?|signature)=)[^&\s]+/gi, "$1[redacted]");
}

export function runGit(
  cwd: string,
  args: string[],
  inheritOutput = false,
  env?: NodeJS.ProcessEnv,
  runner: RawGitRunner = env ? environmentGitRunner(env) : productionGitRunner,
): GitResult {
  const result = runner(cwd, args, inheritOutput ? null : undefined);
  if (inheritOutput) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return { ...result, stdout: "", stderr: "" };
  }
  return result;
}

export function runSub(
  repoRoot: string,
  alias: string,
  args: string[],
  inheritOutput = false,
  runner: RawGitRunner = productionGitRunner,
): GitResult {
  return runGit(aliasDir(repoRoot, alias), args, inheritOutput, undefined, runner);
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


export function aliasDir(repoRoot: string, alias: string): string {
  return join(repoRoot, DATA_DIRNAME, alias);
}

/** Submodule name and path are identical under our convention: oms/<alias>. */
export function submodulePath(alias: string): string {
  return `${DATA_DIRNAME}/${alias}`;
}


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

export function isRegisteredSubmodule(repoRoot: string, sourcePath: string): boolean {
  return registeredSubmodulePaths(repoRoot).includes(sourcePath);
}

export function hasRegisteredSubmodules(repoRoot: string): boolean {
  return registeredSubmodulePaths(repoRoot).length > 0;
}

/** A submodule is initialized when its working tree has a .git gitlink file/dir. */
export function submoduleInitialized(repoRoot: string, alias: string): boolean {
  return existsSync(join(aliasDir(repoRoot, alias), ".git"));
}

/** Detached HEAD and failed inspection both return null for legacy callers. */
export function currentBranch(dir: string, runner: RawGitRunner = productionGitRunner): string | null {
  const r = runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"], false, undefined, runner);
  if (!r.success) return null;
  const b = r.stdout.trim();
  return b && b !== "HEAD" ? b : null;
}

function abbreviatedOid(dir: string, rev: string, runner: RawGitRunner, requireNonempty: boolean): string {
  const result = runGit(dir, ["rev-parse", "--short", rev], false, undefined, runner);
  const oid = result.stdout.trim();
  return result.success && (!requireNonempty || oid.length > 0) ? oid : "???????";
}

export function shortSha(dir: string, runner: RawGitRunner = productionGitRunner): string {
  return abbreviatedOid(dir, "HEAD", runner, false);
}

export function localBranchExists(dir: string, branch: string, runner: RawGitRunner = productionGitRunner): boolean {
  return runGit(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], false, undefined, runner).success;
}

/** Full 40-hex OID of a local branch tip, or null when the branch does not exist. */
export function localBranchOid(dir: string, branch: string, runner: RawGitRunner = productionGitRunner): string | null {
  const r = runGit(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], false, undefined, runner);
  const oid = r.stdout.trim();
  return r.success && /^[0-9a-f]{40}$/.test(oid) ? oid : null;
}

/** Abbreviated OID for an arbitrary revision, or a sentinel when it cannot be read. */
export function shortOid(dir: string, rev: string, runner: RawGitRunner = productionGitRunner): string {
  return abbreviatedOid(dir, rev, runner, true);
}

/** Branch name that origin/HEAD points to (e.g. "main"), or null when the default is unset or dangling. */
export function resolveOriginHead(dir: string, runner: RawGitRunner = productionGitRunner): string | null {
  const r = runGit(dir, ["symbolic-ref", "refs/remotes/origin/HEAD"], false, undefined, runner);
  if (!r.success) return null;
  const ref = r.stdout.trim();
  const name = ref.startsWith("refs/remotes/origin/") ? ref.slice("refs/remotes/origin/".length) : "";
  if (!name) return null;
  // A default that points at a nonexistent remote-tracking branch is not a usable baseline.
  return runGit(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`], false, undefined, runner).success ? name : null;
}

export function remoteBranchExists(dir: string, branch: string, runner: RawGitRunner = productionGitRunner): boolean {
  return runGit(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], false, undefined, runner).success;
}

/** Local branch short names (refs/heads), e.g. ["main", "dev"]. Empty on failure or none. */
export function listLocalBranches(dir: string, runner: RawGitRunner = productionGitRunner): string[] {
  const r = runGit(dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"], false, undefined, runner);
  if (!r.success) return [];
  return r.stdout.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
}

export type LocalBranchInfo = {
  name: string;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
};

export function inspectLocalBranches(
  dir: string,
  runner: RawGitRunner = productionGitRunner,
): { ok: true; branches: LocalBranchInfo[] } | { ok: false; diagnostic: string } {
  const refs = runGit(dir, [
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname:short)\t%(upstream:short)",
    "refs/heads",
  ], false, undefined, runner);
  if (!refs.success) return { ok: false, diagnostic: redactSensitiveUrls(refs.stderr.trim()) };

  const branches = refs.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): LocalBranchInfo => {
      const [name, configuredUpstream = ""] = line.split("\t");
      const upstream = configuredUpstream || null;
      if (upstream === null) return { name, upstream, ahead: null, behind: null };
      const divergence = runGit(dir, ["rev-list", "--left-right", "--count", `${name}...${upstream}`], false, undefined, runner);
      const counts = divergence.success ? divergence.stdout.trim().split(/\s+/).map(Number) : [];
      if (counts.length !== 2 || counts.some((count) => !Number.isFinite(count))) {
        return { name, upstream, ahead: null, behind: null };
      }
      return { name, upstream, ahead: counts[0], behind: counts[1] };
    });
  return { ok: true, branches };
}

/** Enumerate one declared remote namespace, distinguishing failure from a successful empty result. */
export function inspectRemoteBranches(
  dir: string,
  remote: string,
  runner: RawGitRunner = productionGitRunner,
): { ok: true; branches: string[] } | { ok: false; diagnostic: string } {
  const r = runGit(dir, [
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname)",
    `refs/remotes/${remote}`,
  ], false, undefined, runner);
  if (!r.success) return { ok: false, diagnostic: redactSensitiveUrls(r.stderr.trim()) };
  const prefix = `refs/remotes/${remote}/`;
  const branches = r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== `${prefix}HEAD`)
    .map((s) => (s.startsWith(prefix) ? s.slice(prefix.length) : s))
    .filter((s) => s !== "HEAD")
    .sort();
  return { ok: true, branches };
}

/** Remote branch short names under origin, with the "origin/" prefix stripped and origin/HEAD excluded. */
export function listRemoteBranches(dir: string, runner: RawGitRunner = productionGitRunner): string[] {
  const r = runGit(dir, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"], false, undefined, runner);
  if (!r.success) return [];
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "origin/HEAD")
    .map((s) => (s.startsWith("origin/") ? s.slice("origin/".length) : s))
    .filter((s) => s !== "HEAD");
}

export function isDirty(dir: string, runner: RawGitRunner = productionGitRunner): boolean {
  const r = runGit(dir, ["status", "--porcelain"], false, undefined, runner);
  return r.success && r.stdout.trim().length > 0;
}

export function stagedRootPaths(repoRoot: string): string[] {
  const result = runGit(repoRoot, ["diff", "--cached", "--name-only", "-z"]);
  return result.success ? result.stdout.split("\0").filter((path) => path.length > 0) : [];
}
