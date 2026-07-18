import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ALIAS_PATTERN, DATA_DIRNAME } from "./constants.js";

const WORKTREE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const WINDOWS_RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_WORKTREE_NAME_BYTES = 64;

export type ManagedTarget = { alias: string; name: string };
export type EnclosingGitRelation = "same" | "ancestor";

export function commonRepoPath(workspaceRoot: string, alias: string): string {
  return join(workspaceRoot, ".oms", "repos", `${alias}.git`);
}

export function worktreeAliasPath(workspaceRoot: string, alias: string): string {
  return join(workspaceRoot, DATA_DIRNAME, alias);
}

export function managedWorktreePath(workspaceRoot: string, target: ManagedTarget): string {
  return join(worktreeAliasPath(workspaceRoot, target.alias), target.name);
}

export function parseAlias(value: string): string {
  if (!ALIAS_PATTERN.test(value)) throw new Error(`Invalid repository alias "${value}"`);
  return value;
}

export function parseManagedTarget(value: string): ManagedTarget {
  const parts = value.split("/");
  if (parts.length !== 2) throw new Error(`Invalid managed target "${value}"; expected alias/name`);
  const alias = parseAlias(parts[0]);
  validateWorktreeName(parts[1]);
  return { alias, name: parts[1] };
}

export function normalizeWorktreeName(branch: string): string {
  return branch.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function validateWorktreeName(name: string): void {
  if (!WORKTREE_NAME_PATTERN.test(name)
    || Buffer.byteLength(name, "ascii") !== name.length
    || Buffer.byteLength(name, "ascii") > MAX_WORKTREE_NAME_BYTES
    || WINDOWS_RESERVED_NAMES.test(name)
    || name === "."
    || name === "..") {
    throw new Error(
      `Invalid worktree name "${name}"; use one lowercase ASCII slug of at most ${MAX_WORKTREE_NAME_BYTES} bytes`,
    );
  }
}

export function assertUniqueWorktreeName(name: string, existingNames: Iterable<string>): void {
  validateWorktreeName(name);
  const folded = name.toLowerCase();
  if ([...existingNames].some((existing) => existing.toLowerCase() === folded)) {
    throw new Error(`Worktree name "${name}" conflicts with an existing name (case-insensitive)`);
  }
}

export function assertGeneratedPathSupported(path: string): void {
  const resolved = resolve(path);
  for (const component of resolved.split(sep).filter(Boolean)) {
    if (Buffer.byteLength(component) > 255) {
      throw new Error(`Generated path exceeds the host filesystem component limit: ${path}`);
    }
  }
  if (process.platform === "win32" && resolved.length >= 260) {
    throw new Error(`Generated path exceeds the host filesystem path limit: ${path}`);
  }
}

export function assertNoSymlinkComponents(parent: string, candidate: string): void {
  const parentPath = resolve(parent);
  const candidatePath = resolve(candidate);
  const rel = relative(parentPath, candidatePath);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Managed path is outside the workspace: ${candidate}`);
  }
  let current = parentPath;
  for (const component of rel.split(sep)) {
    current = join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Managed path contains a symbolic link: ${current}`);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }
}

export function enclosingGitRelation(workspaceRoot: string, gitRoot: string): EnclosingGitRelation | null {
  const workspace = realpathSync(workspaceRoot);
  const git = realpathSync(gitRoot);
  if (workspace === git) return "same";
  const rel = relative(git, workspace);
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? "ancestor" : null;
}
