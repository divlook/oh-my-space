import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DATA_DIRNAME, MANIFEST_FILENAME, MIN_GIT_MAJOR, MIN_GIT_MINOR } from "./constants.js";
import type { GitResult, WorkspaceOptions } from "./types.js";

/** Remove credentials from URLs while retaining useful host, path, and failure context. */
export function redactSensitiveUrls(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[redacted]@")
    .replace(/([?&](?:(?:access|auth|bearer|id|oauth|refresh)?[_-]?token|(?:api|private)?[_-]?key|auth(?:orization)?|(?:client|consumer)?[_-]?secret|credential|jwt|pass(?:word|wd)?|signature)=)[^&\s]+/gi, "$1[redacted]");
}

export function runGit(cwd: string, args: string[], inheritOutput = false, env?: NodeJS.ProcessEnv): GitResult {
  const redactOutput = inheritOutput && process.env.OMS_REDACT_GIT_DIAGNOSTICS === "1";
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: inheritOutput && !redactOutput ? "inherit" : [redactOutput ? "inherit" : "ignore", "pipe", "pipe"],
    ...(env ? { env } : {}),
  });

  const stdout = inheritOutput && !redactOutput ? "" : (result.stdout ?? "");
  const stderr = inheritOutput && !redactOutput ? "" : (result.stderr ?? "");
  if (redactOutput) {
    if (stdout) process.stdout.write(redactSensitiveUrls(stdout));
    if (stderr) process.stderr.write(redactSensitiveUrls(stderr));
  }

  return {
    exitCode: result.status,
    success: result.status === 0,
    stdout: inheritOutput ? "" : stdout,
    stderr: inheritOutput ? "" : stderr,
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

export type WorkspaceManifestResolution =
  | { kind: "found"; manifestPath: string; repoRoot: string }
  | { kind: "missing" }
  | { kind: "invalid"; manifestPath: string; reason: string };

/** Locate the authoritative nearest manifest without skipping invalid candidates. */
export function resolveWorkspaceManifest(options: WorkspaceOptions = {}): WorkspaceManifestResolution {
  let current = resolve(options.cwd ?? process.cwd());
  while (true) {
    const manifestPath = join(current, MANIFEST_FILENAME);
    let entry;
    try {
      entry = lstatSync(manifestPath);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOENT") {
        const parent = dirname(current);
        if (parent === current) return { kind: "missing" };
        current = parent;
        continue;
      }
      return {
        kind: "invalid",
        manifestPath,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      if (entry.isFile() || (entry.isSymbolicLink() && statSync(manifestPath).isFile())) {
        return { kind: "found", manifestPath, repoRoot: current };
      }
    } catch {
      return {
        kind: "invalid",
        manifestPath,
        reason: "it is a broken symbolic link or does not resolve to a regular file",
      };
    }
    return {
      kind: "invalid",
      manifestPath,
      reason: "it is not a regular file or a symbolic link to a regular file",
    };
  }
}

export function findWorkspaceRoot(options: WorkspaceOptions = {}): string | null {
  const resolution = resolveWorkspaceManifest(options);
  if (resolution.kind === "found") return resolution.repoRoot;
  if (resolution.kind === "missing") return null;
  throw new Error(
    `Found ${MANIFEST_FILENAME} at ${resolution.manifestPath}, but ${resolution.reason}. ` +
      "Replace that entry with a regular file; OMS will not fall back to an ancestor manifest.",
  );
}

export function aliasDir(repoRoot: string, alias: string): string {
  return join(repoRoot, DATA_DIRNAME, alias);
}

/** Submodule name and path are identical under our convention: oms/<alias>. */
export function submodulePath(alias: string): string {
  return `${DATA_DIRNAME}/${alias}`;
}

export type WorkspaceGitIdentity =
  | { kind: "match"; gitTopLevel: string }
  | { kind: "mismatch"; gitTopLevel: string }
  | { kind: "no-work-tree" }
  | { kind: "indeterminate"; reason: string };

/** Compare a workspace directory with Git's enclosing top-level using canonical paths. */
export function inspectWorkspaceGitIdentity(workspaceRoot: string): WorkspaceGitIdentity {
  const topLevel = runGit(workspaceRoot, ["rev-parse", "--show-toplevel"], false, {
    ...process.env,
    LANG: "C",
    LC_ALL: "C",
  });
  if (!topLevel.success) {
    const diagnostic = topLevel.stderr.trim();
    if (/not a git repository|not a git work tree/i.test(diagnostic)) return { kind: "no-work-tree" };
    return {
      kind: "indeterminate",
      reason: diagnostic || "Git did not return a repository top-level",
    };
  }

  const gitTopLevel = process.platform === "win32"
    ? topLevel.stdout.replace(/\r?\n$/, "")
    : topLevel.stdout.replace(/\n$/, "");
  if (!gitTopLevel) {
    return { kind: "indeterminate", reason: "Git returned an empty repository top-level" };
  }

  try {
    return realpathSync(workspaceRoot) === realpathSync(gitTopLevel)
      ? { kind: "match", gitTopLevel }
      : { kind: "mismatch", gitTopLevel };
  } catch (error) {
    return {
      kind: "indeterminate",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
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

/** Full 40-hex OID of a local branch tip, or null when the branch does not exist. */
export function localBranchOid(dir: string, branch: string): string | null {
  const r = runGit(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
  const oid = r.stdout.trim();
  return r.success && /^[0-9a-f]{40}$/.test(oid) ? oid : null;
}

/** Abbreviated OID for an arbitrary revision, or a sentinel when it cannot be read. */
export function shortOid(dir: string, rev: string): string {
  const r = runGit(dir, ["rev-parse", "--short", rev]);
  return r.success && r.stdout.trim().length > 0 ? r.stdout.trim() : "???????";
}

/** Branch name that origin/HEAD points to (e.g. "main"), or null when the default is unset or dangling. */
export function resolveOriginHead(dir: string): string | null {
  const r = runGit(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (!r.success) return null;
  const ref = r.stdout.trim();
  const name = ref.startsWith("origin/") ? ref.slice("origin/".length) : "";
  if (!name) return null;
  // A default that points at a nonexistent remote-tracking branch is not a usable baseline.
  return runGit(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`]).success ? name : null;
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

/** Decision-relevant state for one local branch. */
export type LocalBranchInfo = {
  name: string;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
};

/** Enumerate local refs and each branch's exact configured upstream and divergence. */
export function inspectLocalBranches(
  dir: string,
): { ok: true; branches: LocalBranchInfo[] } | { ok: false; diagnostic: string } {
  const refs = runGit(dir, [
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname:short)\t%(upstream:short)",
    "refs/heads",
  ]);
  if (!refs.success) return { ok: false, diagnostic: redactSensitiveUrls(refs.stderr.trim()) };

  const branches = refs.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): LocalBranchInfo => {
      const [name, configuredUpstream = ""] = line.split("\t");
      const upstream = configuredUpstream || null;
      if (upstream === null) return { name, upstream, ahead: null, behind: null };
      const divergence = runGit(dir, ["rev-list", "--left-right", "--count", `${name}...${upstream}`]);
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
): { ok: true; branches: string[] } | { ok: false; diagnostic: string } {
  const r = runGit(dir, [
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname)",
    `refs/remotes/${remote}`,
  ]);
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
