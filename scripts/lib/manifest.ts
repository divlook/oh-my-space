import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { log } from "@clack/prompts";
import { parse as parseYaml } from "yaml";
import {
  ALIAS_PATTERN,
  ALLOWED_ITEM_KEYS,
  ALLOWED_TOP_KEYS,
  DATA_DIRNAME,
  GITIGNORE_COMMENT,
  GITIGNORE_ENTRY,
  LEGACY_DATA_DIRNAME,
  LEGACY_MANIFEST,
  MANIFEST_FILENAME,
  REMOTE_NAME_PATTERN,
  REMOTES_MIGRATION_DOC,
  RENAME_MIGRATION_DOC,
  WORKTREE_MIGRATION_DOC,
} from "./constants.js";
import { docUrl } from "./env.js";
import {
  aliasDir,
  currentBranch,
  findWorkspaceRoot,
  isGitRepo,
  localBranchExists,
  remoteBranchExists,
  runGit,
  runSub,
  submodulePath,
} from "./git.js";
import type { Repo, WorkspaceOptions } from "./types.js";

export function validateSources(data: unknown): Repo[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${MANIFEST_FILENAME}: root must be a mapping`);
  }
  const obj = data as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_TOP_KEYS.has(key)) {
      throw new Error(`${MANIFEST_FILENAME}: unknown top-level key "${key}"`);
    }
  }
  const { repos } = obj;
  if (!Array.isArray(repos)) {
    throw new Error(`${MANIFEST_FILENAME}: "repos" must be an array`);
  }
  if (repos.length === 0) {
    throw new Error(`${MANIFEST_FILENAME}: "repos" must have at least one item`);
  }

  const validated: Repo[] = [];
  const seen = new Set<string>();

  repos.forEach((item, idx) => {
    const where = `repos[${idx}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${MANIFEST_FILENAME}: ${where} must be a mapping`);
    }
    const r = item as Record<string, unknown>;
    // Friendlier than "unknown key url": the 0.7.0 manifest replaced url with a remotes mapping.
    if ("url" in r && !("remotes" in r)) {
      throw new Error(
        `${MANIFEST_FILENAME}: ${where}.url is no longer supported; use a "remotes" mapping with an "origin" entry. See ${docUrl(REMOTES_MIGRATION_DOC)}`,
      );
    }
    for (const key of Object.keys(r)) {
      if (!ALLOWED_ITEM_KEYS.has(key)) {
        throw new Error(`${MANIFEST_FILENAME}: ${where} has unknown key "${key}"`);
      }
    }
    if (typeof r.alias !== "string" || r.alias.length === 0) {
      throw new Error(`${MANIFEST_FILENAME}: ${where} missing required "alias"`);
    }
    if (!ALIAS_PATTERN.test(r.alias)) {
      throw new Error(
        `${MANIFEST_FILENAME}: ${where}.alias "${r.alias}" must match ${ALIAS_PATTERN}`,
      );
    }
    if (seen.has(r.alias)) {
      throw new Error(`${MANIFEST_FILENAME}: duplicate alias "${r.alias}"`);
    }
    seen.add(r.alias);
    if (!r.remotes || typeof r.remotes !== "object" || Array.isArray(r.remotes)) {
      throw new Error(`${MANIFEST_FILENAME}: ${where} missing required "remotes" mapping`);
    }
    const remoteEntries = Object.entries(r.remotes as Record<string, unknown>);
    if (remoteEntries.length === 0) {
      throw new Error(`${MANIFEST_FILENAME}: ${where}.remotes must have at least one remote`);
    }
    const remotes: Record<string, string> = {};
    for (const [name, url] of remoteEntries) {
      if (!REMOTE_NAME_PATTERN.test(name)) {
        throw new Error(
          `${MANIFEST_FILENAME}: ${where}.remotes name "${name}" must match ${REMOTE_NAME_PATTERN}`,
        );
      }
      if (typeof url !== "string" || url.length === 0) {
        throw new Error(
          `${MANIFEST_FILENAME}: ${where}.remotes.${name} must be a non-empty string URL`,
        );
      }
      remotes[name] = url;
    }
    if (!remotes.origin) {
      throw new Error(`${MANIFEST_FILENAME}: ${where}.remotes must include an "origin" entry`);
    }
    let branch: string | undefined;
    if (r.branch !== undefined) {
      if (typeof r.branch !== "string" || r.branch.length === 0) {
        throw new Error(`${MANIFEST_FILENAME}: ${where}.branch must be a non-empty string`);
      }
      branch = r.branch;
    }
    validated.push({ alias: r.alias, remotes, branch });
  });

  return validated;
}

/** The branch recorded in .gitmodules for the submodule, if any. */
export function gitmodulesBranch(repoRoot: string, alias: string): string | null {
  const r = runGit(repoRoot, [
    "config",
    "--file",
    ".gitmodules",
    "--get",
    `submodule.${submodulePath(alias)}.branch`,
  ]);
  if (!r.success) return null;
  const b = r.stdout.trim();
  return b.length > 0 ? b : null;
}

/**
 * Keep the submodule on a branch instead of a detached HEAD. Only acts when HEAD is detached,
 * so a branch the user is already working on is never disturbed. When no local branch exists
 * yet, a branch is created at the current (pinned) commit — the checked-out commit is preserved,
 * which keeps the parent's recorded pointer reproducible.
 */
export function attachBranch(repoRoot: string, alias: string, branch: string): void {
  if (currentBranch(aliasDir(repoRoot, alias)) !== null) return;

  if (localBranchExists(aliasDir(repoRoot, alias), branch)) {
    runSub(repoRoot, alias, ["switch", branch]);
    return;
  }
  // Create the branch at the current HEAD (the pinned commit) so the worktree stays put.
  if (!runSub(repoRoot, alias, ["switch", "-c", branch]).success) return;
  if (remoteBranchExists(aliasDir(repoRoot, alias), branch)) {
    runSub(repoRoot, alias, ["branch", "--set-upstream-to", `origin/${branch}`, branch]);
  }
}

/**
 * Reconcile the submodule's git remotes with the declared `remotes` map: add missing remotes and
 * update URLs that drifted. Non-destructive — remotes no longer in oms.yaml are left untouched.
 */
export function ensureRemotes(repoRoot: string, alias: string, remotes: Record<string, string>): void {
  for (const [name, url] of Object.entries(remotes)) {
    const existing = runSub(repoRoot, alias, ["remote", "get-url", name]);
    if (!existing.success) {
      runSub(repoRoot, alias, ["remote", "add", name, url]);
    } else if (existing.stdout.trim() !== url) {
      runSub(repoRoot, alias, ["remote", "set-url", name, url]);
    }
  }
}

export function emitLegacyRenameMessage(dir: string, found: { manifest: boolean; data: boolean }): void {
  const artifacts = [
    found.manifest ? `'${LEGACY_MANIFEST}'` : null,
    found.data ? `'${LEGACY_DATA_DIRNAME}/'` : null,
  ]
    .filter((s): s is string => s !== null)
    .join(" and ");
  log.error(
    `detected legacy ${artifacts} at ${dir}.\n` +
      `  oh-my-space 0.4.0 renamed the manifest to ${MANIFEST_FILENAME} and the data directory to ${DATA_DIRNAME}/.\n` +
      `  See ${docUrl(RENAME_MIGRATION_DOC)} for the manual steps. Aborting to avoid destructive change.`,
  );
}

/** Block when the active oms.yaml workspace still has 0.3.x rename artifacts at its root. */
export function abortOnLegacyRenameAt(repoRoot: string): boolean {
  const manifest = existsSync(join(repoRoot, LEGACY_MANIFEST));
  const data = existsSync(join(repoRoot, LEGACY_DATA_DIRNAME));
  if (!manifest && !data) return false;
  emitLegacyRenameMessage(repoRoot, { manifest, data });
  return true;
}

/**
 * When oms.yaml could not be found, walk upward looking for a 0.3.x manifest (sources.yaml).
 * Only the manifest is trusted as a positive signal — a stray sources/ directory by itself
 * could belong to an unrelated tool. Returns true if a hint was emitted.
 */
export function emitLegacyRenameHintWalkUp(options: WorkspaceOptions = {}): boolean {
  let current = resolve(options.cwd ?? process.cwd());
  while (true) {
    if (existsSync(join(current, LEGACY_MANIFEST))) {
      emitLegacyRenameMessage(current, {
        manifest: true,
        data: existsSync(join(current, LEGACY_DATA_DIRNAME)),
      });
      return true;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** Detect leftover 0.3.x–0.5.x bare clone + worktree artifacts (oms/<alias>/.bare). */
export function abortOnLegacyWorktree(repoRoot: string, repos: Repo[]): boolean {
  const stale = repos.find((repo) => existsSync(join(aliasDir(repoRoot, repo.alias), ".bare")));
  if (!stale) return false;
  log.error(
    `detected a legacy bare clone at ${DATA_DIRNAME}/${stale.alias}/.bare. oh-my-space 0.6.0 manages sources as git submodules.\n` +
      `  See ${docUrl(WORKTREE_MIGRATION_DOC)} for the manual steps. Aborting to avoid destructive change.`,
  );
  return true;
}

/** Submodules live inside the parent's history, so oms/ must not be gitignored. Strip a managed entry. */
export function ensureOmsNotIgnored(repoRoot: string): void {
  const path = join(repoRoot, ".gitignore");
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split("\n");
  const out: string[] = [];
  let removed = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === GITIGNORE_ENTRY || trimmed === `/${GITIGNORE_ENTRY}`) {
      if (out.length > 0 && out[out.length - 1].trim() === GITIGNORE_COMMENT) out.pop();
      removed = true;
      continue;
    }
    out.push(line);
  }
  if (removed) {
    writeFileSync(path, out.join("\n"));
    log.info(`removed ${GITIGNORE_ENTRY} from .gitignore (submodules are tracked, not ignored)`);
  }
}

export function gitignoreIgnoresOms(repoRoot: string): boolean {
  const gi = join(repoRoot, ".gitignore");
  return (
    existsSync(gi)
    && readFileSync(gi, "utf8")
      .split("\n")
      .some((l) => l.trim() === GITIGNORE_ENTRY || l.trim() === `/${GITIGNORE_ENTRY}`)
  );
}

export function loadRepos(options: WorkspaceOptions = {}): { repos: Repo[]; repoRoot: string } | null {
  const repoRoot = findWorkspaceRoot(options);
  if (!repoRoot) {
    log.error(
      `Could not find ${MANIFEST_FILENAME} in the current directory or its parents. Create a ${MANIFEST_FILENAME} in this project, then retry.`,
    );
    return null;
  }

  try {
    const manifestPath = join(repoRoot, MANIFEST_FILENAME);
    return { repos: validateSources(parseYaml(readFileSync(manifestPath, "utf8"))), repoRoot };
  } catch (e) {
    log.error(e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** Shared preamble: load manifest, emit legacy hints, and confirm the workspace is a git repo. */
export function loadForSubmodules(): { repos: Repo[]; repoRoot: string } | null {
  const loaded = loadRepos();
  if (!loaded) {
    emitLegacyRenameHintWalkUp();
    return null;
  }
  const { repoRoot, repos } = loaded;
  if (abortOnLegacyRenameAt(repoRoot)) return null;
  if (!isGitRepo(repoRoot)) {
    log.error(
      `${repoRoot} is not a git repository. oh-my-space 0.6.0 manages sources as git submodules; run "git init" at the workspace root first.`,
    );
    return null;
  }
  if (abortOnLegacyWorktree(repoRoot, repos)) return null;
  return loaded;
}
