import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { normalizePath } from "./env.js";
import type { WorkspaceManifest } from "./types.js";
import { inspectWorktreeInventory, verifyCommonRepository } from "./worktree-inspection.js";

function escapeRulePath(path: string): string {
  return normalizePath(path).replace(/[\\[\]*?!#]/g, "\\$&");
}

type ExcludeLock = { path: string; token: string; fd: number; dev: number; ino: number };

function acquireExcludeLock(excludePath: string, workspaceId: string): ExcludeLock {
  const path = `${excludePath}.oms.lock`;
  const token = randomUUID();
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error("The enclosing Git local exclude file is locked; retry after the other OMS operation finishes");
    }
    throw error;
  }
  try {
    writeFileSync(fd, `${JSON.stringify({ version: 1, workspaceId, token, pid: process.pid })}\n`);
    fsyncSync(fd);
    const identity = fstatSync(fd);
    return { path, token, fd, dev: identity.dev, ino: identity.ino };
  } catch (error) {
    const owned = fstatSync(fd);
    closeSync(fd);
    if (existsSync(path)) {
      const current = lstatSync(path);
      if (current.dev === owned.dev && current.ino === owned.ino) rmSync(path, { force: true });
    }
    throw error;
  }
}

function releaseExcludeLock(lock: ExcludeLock): void {
  try {
    if (!existsSync(lock.path)) return;
    const identity = lstatSync(lock.path);
    const current = JSON.parse(readFileSync(lock.path, "utf8")) as { token?: string };
    if (identity.dev !== lock.dev || identity.ino !== lock.ino || current.token !== lock.token) {
      throw new Error("Refusing to remove the local exclude lock because its ownership changed");
    }
    rmSync(lock.path);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Refusing to remove the local exclude lock because its ownership changed");
    }
    throw error;
  } finally {
    closeSync(lock.fd);
  }
}

function runDiscoveryGit(cwd: string, args: string[]): { success: boolean; status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CEILING_DIRECTORIES",
  ]) delete env[key];
  env.GIT_OPTIONAL_LOCKS = "0";
  env.LC_ALL = "C";
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
  return {
    success: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function markerRange(existing: string, workspaceId: string): { start: number; finish: number } | null {
  const marker = /^# oms workspace ([0-9a-f-]+) (begin|end)\r?$/gm;
  const markerLike = existing.split(/\r?\n/).filter((line) => line.startsWith("# oms workspace "));
  if (markerLike.some((line) => !/^# oms workspace [0-9a-f-]+ (?:begin|end)$/.test(line))) {
    throw new Error("The OMS local exclude marker block is malformed; run \"oms doctor\" before retrying");
  }
  let active: { workspaceId: string; start: number } | null = null;
  let own: { start: number; finish: number } | null = null;
  const completed = new Set<string>();
  for (const match of existing.matchAll(marker)) {
    const [, id, kind] = match;
    if (kind === "begin") {
      if (active) throw new Error("The OMS local exclude marker block is malformed; run \"oms doctor\" before retrying");
      active = { workspaceId: id, start: match.index };
      continue;
    }
    if (!active || active.workspaceId !== id) {
      throw new Error("The OMS local exclude marker block is malformed; run \"oms doctor\" before retrying");
    }
    if (completed.has(id)) {
      throw new Error("The OMS local exclude marker block is malformed; run \"oms doctor\" before retrying");
    }
    if (id === workspaceId) {
      if (own) throw new Error("The OMS local exclude marker block is malformed; run \"oms doctor\" before retrying");
      own = { start: active.start, finish: match.index + match[0].length };
    }
    completed.add(id);
    active = null;
  }
  if (active) throw new Error("The OMS local exclude marker block is malformed; run \"oms doctor\" before retrying");
  return own;
}

function absentOrOwnedJsonTree(path: string, workspaceId: string): boolean {
  if (!existsSync(path)) return true;
  const root = lstatSync(path);
  if (!root.isDirectory() || root.isSymbolicLink()) return false;
  let found = false;
  const visit = (directory: string): boolean => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) return false;
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!visit(candidate)) return false;
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) return false;
      try {
        const value = JSON.parse(readFileSync(candidate, "utf8")) as { workspaceId?: string };
        if (value.workspaceId !== workspaceId) return false;
      } catch {
        return false;
      }
      found = true;
    }
    return true;
  };
  return visit(path) && found;
}

function absentOrOwnedCommonTree(
  workspaceRoot: string,
  workspaceId: string,
  manifest: WorkspaceManifest,
): boolean {
  const path = join(workspaceRoot, ".oms", "repos");
  if (!existsSync(path)) return true;
  const root = lstatSync(path);
  if (!root.isDirectory() || root.isSymbolicLink()) return false;
  const entries = readdirSync(path, { withFileTypes: true });
  if (entries.length === 0) return false;
  try {
    return entries.every((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.endsWith(".git")) return false;
      const alias = entry.name.slice(0, -4);
      if (!manifest.repos.some((repo) => repo.alias === alias)) return false;
      verifyCommonRepository(workspaceRoot, alias, workspaceId);
      return true;
    });
  } catch {
    return false;
  }
}

function ownedCheckoutRules(
  workspaceRoot: string,
  workspaceId: string,
  manifest: WorkspaceManifest,
): string[] {
  const rules: string[] = [];
  for (const repo of manifest.repos) {
    try {
      const inventory = inspectWorktreeInventory(workspaceRoot, repo.alias, workspaceId);
      for (const entry of inventory.worktrees) {
        if (entry.managed && !entry.stale && entry.name) rules.push(`oms/${repo.alias}/${entry.name}/`);
      }
    } catch {
      // Unowned, missing, or partial repositories must remain visible to the enclosing Git repository.
    }
  }
  return rules;
}

export function reconcileControlFileExcludes(
  workspaceRoot: string,
  workspaceId: string,
  manifest?: WorkspaceManifest,
): void {
  const topLevelResult = runDiscoveryGit(workspaceRoot, ["rev-parse", "--show-toplevel"]);
  if (!topLevelResult.success) {
    if (topLevelResult.status === 128 && /not a git repository/i.test(topLevelResult.stderr)) return;
    throw new Error(`Could not inspect the enclosing Git repository: ${topLevelResult.stderr.trim() || "git failed"}`);
  }
  const gitRoot = topLevelResult.stdout.trim();
  if (!gitRoot) return;
  const gitPathResult = runDiscoveryGit(workspaceRoot, ["rev-parse", "--git-path", "info/exclude"]);
  if (!gitPathResult.success || !gitPathResult.stdout.trim()) {
    throw new Error("Could not resolve the enclosing Git local exclude file");
  }
  const rawExcludePath = gitPathResult.stdout.trim();
  const excludePath = isAbsolute(rawExcludePath) ? rawExcludePath : resolve(workspaceRoot, rawExcludePath);
  const lock = acquireExcludeLock(excludePath, workspaceId);
  try {
    const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
    const existingStat = existsSync(excludePath) ? statSync(excludePath) : null;
    const newline = existing.includes("\r\n") ? "\r\n" : "\n";
    const begin = `# oms workspace ${workspaceId} begin`;
    const end = `# oms workspace ${workspaceId} end`;
    const range = markerRange(existing, workspaceId);

    const prefix = relative(gitRoot, workspaceRoot);
    const managedPaths = [".oms/workspace.json", ".oms-mutation.lock", ".oms-mode-switch.json"];
    if (manifest?.mode === "worktree") {
      if (absentOrOwnedCommonTree(workspaceRoot, workspaceId, manifest)) managedPaths.push(".oms/repos/");
      if (absentOrOwnedJsonTree(join(workspaceRoot, ".oms", "provisioning"), workspaceId)) {
        managedPaths.push(".oms/provisioning/");
      }
      if (absentOrOwnedJsonTree(join(workspaceRoot, ".oms", "fetch-provenance"), workspaceId)) {
        managedPaths.push(".oms/fetch-provenance/");
      }
      managedPaths.push(...ownedCheckoutRules(workspaceRoot, workspaceId, manifest));
    }
    const rules = managedPaths
      .map((path) => `/${escapeRulePath(prefix ? join(prefix, path) : path)}`);
    const block = [begin, ...rules, end].join(newline);
    let next: string;
    if (range) {
      next = existing.slice(0, range.start) + block + existing.slice(range.finish);
    } else {
      const separator = existing.length === 0 || existing.endsWith("\n") ? "" : newline;
      next = `${existing}${separator}${block}${newline}`;
    }
    if (next === existing) return;

    const mode = existingStat ? existingStat.mode & 0o7777 : 0o600;
    const temporary = `${excludePath}.oms.${process.pid}.${workspaceId}`;
    let fd: number | null = null;
    try {
      fd = openSync(temporary, "wx", mode);
      try {
        writeFileSync(fd, next);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
        fd = null;
      }
      if (existingStat) chownSync(temporary, existingStat.uid, existingStat.gid);
      chmodSync(temporary, mode);
      const beforeReadStat = existsSync(excludePath) ? statSync(excludePath) : null;
      const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
      const currentStat = existsSync(excludePath) ? statSync(excludePath) : null;
      if (current !== existing
        || Boolean(currentStat) !== Boolean(existingStat)
        || (currentStat && existingStat && (currentStat.dev !== existingStat.dev
          || currentStat.ino !== existingStat.ino || currentStat.mode !== existingStat.mode
          || currentStat.uid !== existingStat.uid || currentStat.gid !== existingStat.gid
          || currentStat.size !== existingStat.size || currentStat.mtimeMs !== existingStat.mtimeMs
          || currentStat.ctimeMs !== existingStat.ctimeMs))
        || Boolean(beforeReadStat) !== Boolean(currentStat)
        || (beforeReadStat && currentStat && (beforeReadStat.dev !== currentStat.dev
          || beforeReadStat.ino !== currentStat.ino || beforeReadStat.size !== currentStat.size
          || beforeReadStat.mtimeMs !== currentStat.mtimeMs || beforeReadStat.ctimeMs !== currentStat.ctimeMs))) {
        throw new Error("The enclosing Git local exclude file changed during reconciliation; retry without concurrent edits");
      }
      renameSync(temporary, excludePath);
    } finally {
      if (fd !== null) closeSync(fd);
      rmSync(temporary, { force: true });
    }
  } finally {
    releaseExcludeLock(lock);
  }
}

/** Reports worktree-only local-exclude rules that must not survive in submodule mode. */
export function unexpectedWorktreeExcludeRules(
  workspaceRoot: string,
  workspaceId: string,
): string | null {
  const topLevelResult = runDiscoveryGit(workspaceRoot, ["rev-parse", "--show-toplevel"]);
  if (!topLevelResult.success) {
    if (topLevelResult.status === 128 && /not a git repository/i.test(topLevelResult.stderr)) return null;
    throw new Error(`Could not inspect the enclosing Git repository: ${topLevelResult.stderr.trim() || "git failed"}`);
  }
  const gitPathResult = runDiscoveryGit(workspaceRoot, ["rev-parse", "--git-path", "info/exclude"]);
  if (!gitPathResult.success || !gitPathResult.stdout.trim()) {
    throw new Error("Could not resolve the enclosing Git local exclude file");
  }
  const rawPath = gitPathResult.stdout.trim();
  const excludePath = isAbsolute(rawPath) ? rawPath : resolve(workspaceRoot, rawPath);
  if (!existsSync(excludePath)) return null;
  const existing = readFileSync(excludePath, "utf8");
  const range = markerRange(existing, workspaceId);
  if (!range) return null;
  const block = existing.slice(range.start, range.finish);
  const stale = block.split(/\r?\n/).find((line) =>
    /\/(?:\.oms\/(?:repos|provisioning|fetch-provenance)\/|oms\/[^/]+\/[^/]+\/)\s*$/.test(line));
  return stale?.trim() ?? null;
}

/** Inspect the enclosing Git local-exclude block without locking or changing it. */
export function inspectControlFileExcludes(
  workspaceRoot: string,
  workspaceId: string,
  manifest: WorkspaceManifest,
): string[] {
  const issues: string[] = [];
  const topLevelResult = runDiscoveryGit(workspaceRoot, ["rev-parse", "--show-toplevel"]);
  if (!topLevelResult.success) {
    if (topLevelResult.status === 128 && /not a git repository/i.test(topLevelResult.stderr)) return issues;
    return [`Could not inspect the enclosing Git repository: ${topLevelResult.stderr.trim() || "git failed"}`];
  }
  const gitRoot = topLevelResult.stdout.trim();
  const gitPathResult = runDiscoveryGit(workspaceRoot, ["rev-parse", "--git-path", "info/exclude"]);
  if (!gitPathResult.success || !gitPathResult.stdout.trim()) return ["Could not resolve the enclosing Git local exclude file"];
  const rawPath = gitPathResult.stdout.trim();
  const excludePath = isAbsolute(rawPath) ? rawPath : resolve(workspaceRoot, rawPath);
  if (existsSync(`${excludePath}.oms.lock`)) issues.push("The enclosing Git local exclude file has an OMS lock");
  const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  let range: { start: number; finish: number } | null;
  try {
    range = markerRange(existing, workspaceId);
  } catch (error) {
    return [...issues, error instanceof Error ? error.message : String(error)];
  }
  if (!range) return [...issues, "The workspace-owned local exclude marker block is missing"];
  const prefix = relative(gitRoot, workspaceRoot);
  const required = [".oms/workspace.json", ".oms-mutation.lock", ".oms-mode-switch.json"];
  if (manifest.mode === "worktree") {
    if (absentOrOwnedCommonTree(workspaceRoot, workspaceId, manifest)) required.push(".oms/repos/");
    if (absentOrOwnedJsonTree(join(workspaceRoot, ".oms", "provisioning"), workspaceId)) required.push(".oms/provisioning/");
    if (absentOrOwnedJsonTree(join(workspaceRoot, ".oms", "fetch-provenance"), workspaceId)) required.push(".oms/fetch-provenance/");
    required.push(...ownedCheckoutRules(workspaceRoot, workspaceId, manifest));
  }
  const block = existing.slice(range.start, range.finish);
  for (const path of required) {
    const rule = `/${escapeRulePath(prefix ? join(prefix, path) : path)}`;
    if (!block.split(/\r?\n/).includes(rule)) issues.push(`The workspace-owned local exclude block is missing ${path}`);
  }
  if (manifest.mode === "submodule") {
    const stale = unexpectedWorktreeExcludeRules(workspaceRoot, workspaceId);
    if (stale) issues.push(`The local exclude block retains worktree-only rule ${stale}`);
  }
  return issues;
}
