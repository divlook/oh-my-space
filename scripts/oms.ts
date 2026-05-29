#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { cancel, isCancel, log, multiselect, select } from "@clack/prompts";
import { parse as parseYaml } from "yaml";

type Repo = {
  alias: string;
  /** Named git remotes; must include "origin". Maps remote name to its clonable URL. */
  remotes: Record<string, string>;
  branch?: string;
};

type SourcesOptions = {
  all?: boolean;
  list?: boolean;
};

type UnsyncOptions = SourcesOptions & {
  force?: boolean;
};

type PushOptions = {
  commit?: boolean;
};

type RemoteOptions = {
  /** Remote name(s) requested via repeatable --remote; empty/undefined means "resolve interactively or default to origin". */
  remote?: string[];
};

type CheckoutOptions = {
  from?: string;
};

type WorkspaceOptions = {
  cwd?: string;
};

type OperationResult =
  | "added"
  | "updated"
  | "fetched"
  | "pulled"
  | "pushed"
  | "unsynced"
  | "failed";

type RemoveOutcome = "removed" | "nothing-to-remove" | "failed";

type GitResult = {
  exitCode: number | null;
  success: boolean;
  stdout: string;
};

type ManageCommand = "fetch" | "pull" | "push";

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const ALLOWED_TOP_KEYS = new Set(["repos"]);
const ALLOWED_ITEM_KEYS = new Set(["alias", "remotes", "branch"]);
const MANIFEST_FILENAME = "oms.yaml";
const DATA_DIRNAME = "oms";
const GITIGNORE_ENTRY = `${DATA_DIRNAME}/`;
const GITIGNORE_COMMENT = "# managed by oms";
const LEGACY_MANIFEST = "sources.yaml";
const LEGACY_DATA_DIRNAME = "sources";
const RENAME_MIGRATION_DOC = "docs/migrations/0.3.x-to-0.4.0.md";
const WORKTREE_MIGRATION_DOC = "docs/migrations/0.5.x-to-0.6.0.md";
const REMOTES_MIGRATION_DOC = "docs/migrations/0.6.x-to-0.7.0.md";
/** GitHub blob base for the clickable doc permalinks shown in CLI messages. */
const DOCS_REPO_BLOB_BASE = "https://github.com/divlook/oh-my-space/blob";
const MIN_GIT_MAJOR = 2;
const MIN_GIT_MINOR = 40;

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const useColor = process.stdout.isTTY;
const dim = (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);

function validateSources(data: unknown): Repo[] {
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

function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - s.length));
}

/** Names of a repo's non-origin remotes, in declared order (origin is shown via its URL column). */
function extraRemoteNames(repo: Repo): string[] {
  return Object.keys(repo.remotes).filter((name) => name !== "origin");
}

function printList(repos: Repo[]): void {
  const extras = (r: Repo) => {
    const names = extraRemoteNames(r);
    return names.length > 0 ? ` (+${names.join(",")})` : "";
  };
  const aliasW = Math.max("ALIAS".length, ...repos.map((r) => r.alias.length));
  const urlW = Math.max(
    "ORIGIN".length,
    ...repos.map((r) => (r.remotes.origin + extras(r)).length),
  );
  console.log(dim(`${pad("ALIAS", aliasW)}  ${pad("ORIGIN", urlW)}  BRANCH`));
  for (const r of repos) {
    console.log(`${pad(r.alias, aliasW)}  ${pad(r.remotes.origin + extras(r), urlW)}  ${r.branch ?? ""}`);
  }
}

async function selectInteractive(repos: Repo[], actionLabel: string): Promise<Repo[] | null> {
  const choice = await multiselect({
    message: `Select source repos to ${actionLabel} (space to toggle, enter to confirm)`,
    options: repos.map((r) => ({
      value: r.alias,
      label: r.alias,
      hint: r.branch ? `branch: ${r.branch}` : undefined,
    })),
    required: true,
  });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    return null;
  }
  return choice
    .map((alias) => repos.find((r) => r.alias === alias))
    .filter((r): r is Repo => r !== undefined);
}

/**
 * Decide which remote(s) a fetch/pull/push targets for one repo. Honors an explicit --remote list,
 * otherwise prompts interactively on a TTY (origin preselected) and falls back to origin off-TTY.
 * pull is restricted to a single remote since --ff-only can advance to at most one. Returns the
 * resolved remote names, or null when the request is invalid or the prompt was cancelled.
 */
async function resolveRemotes(
  repo: Repo,
  requested: string[] | undefined,
  command: ManageCommand,
): Promise<string[] | null> {
  const declared = Object.keys(repo.remotes);

  if (requested && requested.length > 0) {
    const unique = uniqueAliases(requested);
    const unknown = unique.filter((name) => !declared.includes(name));
    if (unknown.length > 0) {
      log.error(
        `${repo.alias}: unknown remote(s): ${unknown.join(", ")}. Declared: ${declared.join(", ")}.`,
      );
      return null;
    }
    if (command === "pull" && unique.length > 1) {
      log.error(`${repo.alias}: pull targets a single remote (git pull --ff-only can advance only one).`);
      return null;
    }
    return unique;
  }

  // No explicit remote: a lone origin needs no prompt, and a non-interactive shell defaults to origin.
  if (declared.length === 1) return declared;
  if (!process.stdin.isTTY) return ["origin"];

  if (command === "pull") {
    const choice = await select({
      message: `${repo.alias}: select a remote to ${command}`,
      options: declared.map((name) => ({ value: name, label: name, hint: repo.remotes[name] })),
      initialValue: "origin",
    });
    if (isCancel(choice)) {
      cancel("Cancelled.");
      return null;
    }
    return [choice as string];
  }

  const choice = await multiselect({
    message: `${repo.alias}: select remote(s) to ${command} (space to toggle, enter to confirm)`,
    options: declared.map((name) => ({ value: name, label: name, hint: repo.remotes[name] })),
    initialValues: ["origin"],
    required: true,
  });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    return null;
  }
  return choice as string[];
}

function runGit(cwd: string, args: string[], inheritOutput = false): GitResult {
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
function runSub(repoRoot: string, alias: string, args: string[], inheritOutput = false): GitResult {
  return runGit(aliasDir(repoRoot, alias), args, inheritOutput);
}

function parseGitVersion(s: string): { major: number; minor: number } | null {
  const m = s.match(/git version (\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number.parseInt(m[1], 10), minor: Number.parseInt(m[2], 10) };
}

function isGitVersionSupported(v: { major: number; minor: number }): boolean {
  if (v.major > MIN_GIT_MAJOR) return true;
  if (v.major < MIN_GIT_MAJOR) return false;
  return v.minor >= MIN_GIT_MINOR;
}

function findWorkspaceRoot(options: WorkspaceOptions = {}): string | null {
  let current = resolve(options.cwd ?? process.cwd());
  while (true) {
    if (existsSync(join(current, MANIFEST_FILENAME))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function aliasDir(repoRoot: string, alias: string): string {
  return join(repoRoot, DATA_DIRNAME, alias);
}

/** Submodule name and path are identical under our convention: oms/<alias>. */
function submodulePath(alias: string): string {
  return `${DATA_DIRNAME}/${alias}`;
}

function isGitRepo(repoRoot: string): boolean {
  return runGit(repoRoot, ["rev-parse", "--is-inside-work-tree"]).stdout.trim() === "true";
}

/** True when .gitmodules registers a submodule at the given path (sources/<alias> or oms/<alias>). */
function isRegisteredSubmodule(repoRoot: string, sourcePath: string): boolean {
  if (!existsSync(join(repoRoot, ".gitmodules"))) return false;

  const result = runGit(repoRoot, [
    "config",
    "--file",
    ".gitmodules",
    "--get-regexp",
    "^submodule\\..*\\.path$",
  ]);
  if (!result.success) return false;

  return result.stdout
    .split("\n")
    .some((line) => line.trim().split(/\s+/)[1] === sourcePath);
}

/** A submodule is initialized when its working tree has a .git gitlink file/dir. */
function submoduleInitialized(repoRoot: string, alias: string): boolean {
  return existsSync(join(aliasDir(repoRoot, alias), ".git"));
}

/** Short branch name, or null when HEAD is detached. */
function currentBranch(dir: string): string | null {
  const r = runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!r.success) return null;
  const b = r.stdout.trim();
  return b && b !== "HEAD" ? b : null;
}

function shortSha(dir: string): string {
  const r = runGit(dir, ["rev-parse", "--short", "HEAD"]);
  return r.success ? r.stdout.trim() : "???????";
}

function localBranchExists(dir: string, branch: string): boolean {
  return runGit(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).success;
}

function remoteBranchExists(dir: string, branch: string): boolean {
  return runGit(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).success;
}

function isDirty(dir: string): boolean {
  const r = runGit(dir, ["status", "--porcelain"]);
  return r.success && r.stdout.trim().length > 0;
}

/** The branch recorded in .gitmodules for the submodule, if any. */
function gitmodulesBranch(repoRoot: string, alias: string): string | null {
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
function attachBranch(repoRoot: string, alias: string, branch: string): void {
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
function ensureRemotes(repoRoot: string, alias: string, remotes: Record<string, string>): void {
  for (const [name, url] of Object.entries(remotes)) {
    const existing = runSub(repoRoot, alias, ["remote", "get-url", name]);
    if (!existing.success) {
      runSub(repoRoot, alias, ["remote", "add", name, url]);
    } else if (existing.stdout.trim() !== url) {
      runSub(repoRoot, alias, ["remote", "set-url", name, url]);
    }
  }
}

/** Stage the submodule gitlink in the parent so a moved pointer shows up and is ready to commit. */
function stagePointer(repoRoot: string, alias: string): void {
  runGit(repoRoot, ["add", "--", submodulePath(alias)]);
}

function emitLegacyRenameMessage(dir: string, found: { manifest: boolean; data: boolean }): void {
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
function abortOnLegacyRenameAt(repoRoot: string): boolean {
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
function emitLegacyRenameHintWalkUp(options: WorkspaceOptions = {}): boolean {
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
function abortOnLegacyWorktree(repoRoot: string, repos: Repo[]): boolean {
  const stale = repos.find((repo) => existsSync(join(aliasDir(repoRoot, repo.alias), ".bare")));
  if (!stale) return false;
  log.error(
    `detected a legacy bare clone at ${DATA_DIRNAME}/${stale.alias}/.bare. oh-my-space 0.6.0 manages sources as git submodules.\n` +
      `  See ${docUrl(WORKTREE_MIGRATION_DOC)} for the manual steps. Aborting to avoid destructive change.`,
  );
  return true;
}

/** Submodules live inside the parent's history, so oms/ must not be gitignored. Strip a managed entry. */
function ensureOmsNotIgnored(repoRoot: string): void {
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

function gitignoreIgnoresOms(repoRoot: string): boolean {
  const gi = join(repoRoot, ".gitignore");
  return (
    existsSync(gi)
    && readFileSync(gi, "utf8")
      .split("\n")
      .some((l) => l.trim() === GITIGNORE_ENTRY || l.trim() === `/${GITIGNORE_ENTRY}`)
  );
}

function cleanupFailedAdd(repoRoot: string, alias: string): void {
  const path = submodulePath(alias);
  runGit(repoRoot, ["submodule", "deinit", "-f", "--", path]);
  runGit(repoRoot, ["rm", "-f", "--cached", "--", path]);
  runGit(repoRoot, ["config", "--file", ".gitmodules", "--remove-section", `submodule.${path}`]);
  if (existsSync(join(repoRoot, ".gitmodules"))) runGit(repoRoot, ["add", ".gitmodules"]);
  try {
    rmSync(join(repoRoot, ".git", "modules", DATA_DIRNAME, alias), { recursive: true, force: true });
  } catch {}
  try {
    if (existsSync(aliasDir(repoRoot, alias))) rmSync(aliasDir(repoRoot, alias), { recursive: true, force: true });
  } catch {}
}

function syncRepo(repo: Repo, repoRoot: string): OperationResult {
  const alias = repo.alias;
  const path = submodulePath(alias);
  const registered = isRegisteredSubmodule(repoRoot, path);

  if (!registered) {
    if (existsSync(aliasDir(repoRoot, alias)) && readdirSync(aliasDir(repoRoot, alias)).length > 0) {
      log.error(
        `${alias}: ${path}/ already exists but is not a registered submodule. Move or remove it manually, then retry.`,
      );
      return "failed";
    }

    if (repo.branch) {
      const lsRemote = runGit(repoRoot, [
        "ls-remote",
        "--exit-code",
        "--heads",
        repo.remotes.origin,
        repo.branch,
      ]);
      if (lsRemote.exitCode === 2) {
        log.error(
          `${alias}: branch "${repo.branch}" not found on ${repo.remotes.origin}. Push the branch upstream or fix the alias, then retry.`,
        );
        return "failed";
      }
      if (!lsRemote.success && lsRemote.exitCode !== 2) {
        log.warn(`${alias}: branch existence check failed (exit ${lsRemote.exitCode}); proceeding.`);
      }
    }

    // `git submodule add` refuses when .gitmodules is tracked in HEAD but missing from the
    // working tree — the state left by an uncommitted unsync. Restore an empty one so it can append.
    const gitmodules = join(repoRoot, ".gitmodules");
    if (!existsSync(gitmodules) && runGit(repoRoot, ["cat-file", "-e", "HEAD:.gitmodules"]).success) {
      writeFileSync(gitmodules, "");
    }

    log.step(`${alias}: git submodule add${repo.branch ? ` -b ${repo.branch}` : ""} ${repo.remotes.origin} ${path}`);
    const args = ["submodule", "add", ...(repo.branch ? ["-b", repo.branch] : []), "--", repo.remotes.origin, path];
    const add = runGit(repoRoot, args, true);
    if (!add.success) {
      log.error(`${alias}: git submodule add failed (exit ${add.exitCode})`);
      cleanupFailedAdd(repoRoot, alias);
      return "failed";
    }
    ensureRemotes(repoRoot, alias, repo.remotes);
    const branch = repo.branch ?? currentBranch(aliasDir(repoRoot, alias));
    if (branch) attachBranch(repoRoot, alias, branch);
    log.success(`${alias}: added${branch ? ` (branch=${branch})` : ""}`);
    return "added";
  }

  if (!submoduleInitialized(repoRoot, alias)) {
    log.step(`${alias}: git submodule update --init ${path}`);
    const upd = runGit(repoRoot, ["submodule", "update", "--init", "--", path], true);
    if (!upd.success) {
      log.error(`${alias}: git submodule update --init failed (exit ${upd.exitCode})`);
      return "failed";
    }
    ensureRemotes(repoRoot, alias, repo.remotes);
    const branch = gitmodulesBranch(repoRoot, alias) ?? repo.branch;
    if (branch) attachBranch(repoRoot, alias, branch);
    log.success(`${alias}: initialized${branch ? ` (branch=${branch})` : ""}`);
    return "added";
  }

  ensureRemotes(repoRoot, alias, repo.remotes);
  log.step(`${alias}: git fetch origin --prune`);
  const fetch = runSub(repoRoot, alias, ["fetch", "origin", "--prune"], true);
  if (!fetch.success) {
    log.error(`${alias}: fetch failed (exit ${fetch.exitCode})`);
    return "failed";
  }
  const branch = gitmodulesBranch(repoRoot, alias) ?? repo.branch;
  if (branch) attachBranch(repoRoot, alias, branch);
  log.success(`${alias}: updated`);
  return "updated";
}

function unsyncRepo(repo: Repo, repoRoot: string, force: boolean): RemoveOutcome {
  const alias = repo.alias;
  const path = submodulePath(alias);
  const registered = isRegisteredSubmodule(repoRoot, path);
  const exists = existsSync(aliasDir(repoRoot, alias));

  if (!registered && !exists) return "nothing-to-remove";

  if (!force && submoduleInitialized(repoRoot, alias) && isDirty(aliasDir(repoRoot, alias))) {
    log.error(
      `${alias}: ${path} has uncommitted changes. Commit, stash, or pass --force.`,
    );
    return "failed";
  }

  runGit(repoRoot, ["submodule", "deinit", ...(force ? ["-f"] : []), "--", path]);
  const rm = runGit(repoRoot, ["rm", "-f", "--", path], true);
  if (!rm.success) {
    // Fall back to manual unregistration (e.g. the submodule was never initialized).
    runGit(repoRoot, ["rm", "-f", "--cached", "--", path]);
    runGit(repoRoot, ["config", "--file", ".gitmodules", "--remove-section", `submodule.${path}`]);
    if (existsSync(join(repoRoot, ".gitmodules"))) runGit(repoRoot, ["add", ".gitmodules"]);
  }
  try {
    rmSync(join(repoRoot, ".git", "modules", DATA_DIRNAME, alias), { recursive: true, force: true });
  } catch {}
  if (existsSync(aliasDir(repoRoot, alias))) {
    rmSync(aliasDir(repoRoot, alias), { recursive: true, force: true });
  }
  // Drop the now-empty oms/ directory if nothing else lives there.
  try {
    const parent = join(repoRoot, DATA_DIRNAME);
    if (existsSync(parent) && readdirSync(parent).length === 0) rmdirSync(parent);
  } catch {}

  // Drop a .gitmodules that no longer registers any submodule (git rm leaves it empty).
  const gitmodules = join(repoRoot, ".gitmodules");
  if (existsSync(gitmodules) && readFileSync(gitmodules, "utf8").trim().length === 0) {
    if (!runGit(repoRoot, ["rm", "-f", "--", ".gitmodules"]).success) {
      rmSync(gitmodules, { force: true });
    }
  }

  return "removed";
}

function fetchRepo(repo: Repo, repoRoot: string, remotes: string[]): OperationResult {
  if (!submoduleInitialized(repoRoot, repo.alias)) {
    log.error(`${repo.alias}: not synced. Run "oms sync ${repo.alias}" first.`);
    return "failed";
  }
  for (const remote of remotes) {
    log.step(`${repo.alias}: git fetch ${remote} --prune`);
    const r = runSub(repoRoot, repo.alias, ["fetch", remote, "--prune"], true);
    if (!r.success) {
      log.error(`${repo.alias}: fetch ${remote} failed (exit ${r.exitCode})`);
      return "failed";
    }
  }
  log.success(`${repo.alias}: fetched (${remotes.join(", ")})`);
  return "fetched";
}

function pullRepo(repo: Repo, repoRoot: string, remote: string): OperationResult {
  if (!submoduleInitialized(repoRoot, repo.alias)) {
    log.error(`${repo.alias}: not synced. Run "oms sync ${repo.alias}" first.`);
    return "failed";
  }
  const branch = currentBranch(aliasDir(repoRoot, repo.alias));
  if (!branch) {
    log.error(
      `${repo.alias}: detached HEAD. Run "oms checkout ${repo.alias} <branch>" before pulling.`,
    );
    return "failed";
  }
  log.step(`${repo.alias}/${branch}: git pull --ff-only ${remote} ${branch}`);
  const r = runSub(repoRoot, repo.alias, ["pull", "--ff-only", remote, branch], true);
  if (r.success) {
    stagePointer(repoRoot, repo.alias);
    log.success(`${repo.alias}/${branch}: pulled from ${remote}`);
    return "pulled";
  }
  log.error(`${repo.alias}/${branch}: pull from ${remote} failed (exit ${r.exitCode})`);
  return "failed";
}

function pushRepo(repo: Repo, repoRoot: string, remotes: string[], commit: boolean): OperationResult {
  if (!submoduleInitialized(repoRoot, repo.alias)) {
    log.error(`${repo.alias}: not synced. Run "oms sync ${repo.alias}" first.`);
    return "failed";
  }
  const branch = currentBranch(aliasDir(repoRoot, repo.alias));
  if (!branch) {
    log.error(
      `${repo.alias}: detached HEAD. Run "oms checkout ${repo.alias} <branch>" before pushing.`,
    );
    return "failed";
  }
  for (const remote of remotes) {
    // Only origin sets upstream — repointing @{u} to a fork would skew "oms status" ahead/behind.
    const args = remote === "origin" ? ["push", "-u", "origin", branch] : ["push", remote, branch];
    log.step(`${repo.alias}/${branch}: git ${args.join(" ")}`);
    const r = runSub(repoRoot, repo.alias, args, true);
    if (!r.success) {
      log.error(`${repo.alias}/${branch}: push to ${remote} failed (exit ${r.exitCode})`);
      return "failed";
    }
  }
  stagePointer(repoRoot, repo.alias);
  if (commit) {
    const sha = shortSha(aliasDir(repoRoot, repo.alias));
    runGit(repoRoot, ["commit", "-m", `oms: bump ${repo.alias} to ${sha}`, "--", submodulePath(repo.alias)]);
  }
  log.success(`${repo.alias}/${branch}: pushed to ${remotes.join(", ")}${commit ? " and recorded pointer" : ""}`);
  return "pushed";
}

function printSummary(results: OperationResult[]): void {
  const counts: Record<OperationResult, number> = {
    added: 0,
    updated: 0,
    fetched: 0,
    pulled: 0,
    pushed: 0,
    unsynced: 0,
    failed: 0,
  };
  for (const r of results) counts[r]++;

  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name} ${count}`);
  log.message(`Summary: ${parts.join(", ")}`);
}

function exitFromResults(results: OperationResult[]): number {
  return results.includes("failed") ? 2 : 0;
}

function loadRepos(options: WorkspaceOptions = {}): { repos: Repo[]; repoRoot: string } | null {
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
function loadForSubmodules(): { repos: Repo[]; repoRoot: string } | null {
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

function uniqueAliases(aliases: string[]): string[] {
  const seen = new Set<string>();
  return aliases.filter((alias) => {
    if (seen.has(alias)) return false;
    seen.add(alias);
    return true;
  });
}

async function selectRepos(
  repos: Repo[],
  aliases: string[],
  options: SourcesOptions,
  actionLabel: string,
): Promise<Repo[] | null> {
  if (options.all) return repos;

  if (aliases.length === 0) {
    return selectInteractive(repos, actionLabel);
  }

  const unknown = aliases.filter((a) => !repos.some((r) => r.alias === a));
  if (unknown.length > 0) {
    log.error(
      `Unknown alias(es): ${unknown.join(", ")}. Use "oms sync --list" to see available aliases.`,
    );
    return null;
  }

  const byAlias = new Map(repos.map((repo) => [repo.alias, repo]));
  return uniqueAliases(aliases).map((alias) => byAlias.get(alias)!);
}

async function runSync(aliases: string[], options: SourcesOptions): Promise<number> {
  const loaded = loadRepos();
  if (!loaded) {
    emitLegacyRenameHintWalkUp();
    return 1;
  }
  const { repos, repoRoot } = loaded;
  if (abortOnLegacyRenameAt(repoRoot)) return 1;

  if (options.list) {
    printList(repos);
    return 0;
  }

  if (!isGitRepo(repoRoot)) {
    log.error(
      `${repoRoot} is not a git repository. oh-my-space 0.6.0 manages sources as git submodules; run "git init" at the workspace root first.`,
    );
    return 1;
  }
  if (abortOnLegacyWorktree(repoRoot, repos)) return 1;

  const picked = await selectRepos(repos, aliases, options, "sync");
  if (!picked || picked.length === 0) return 1;

  ensureOmsNotIgnored(repoRoot);

  const results = picked.map((repo) => syncRepo(repo, repoRoot));
  if (results.length > 1 || options.all) printSummary(results);
  return exitFromResults(results);
}

async function runManage(
  command: ManageCommand,
  aliases: string[],
  options: SourcesOptions & PushOptions & RemoteOptions,
): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  const picked = await selectRepos(repos, aliases, options, command);
  if (!picked || picked.length === 0) return 1;

  const results: OperationResult[] = [];
  for (const repo of picked) {
    const remotes = await resolveRemotes(repo, options.remote, command);
    if (!remotes || remotes.length === 0) {
      results.push("failed");
      continue;
    }
    if (command === "fetch") results.push(fetchRepo(repo, repoRoot, remotes));
    else if (command === "pull") results.push(pullRepo(repo, repoRoot, remotes[0]));
    else results.push(pushRepo(repo, repoRoot, remotes, options.commit ?? false));
  }
  if (results.length > 1 || options.all) printSummary(results);
  return exitFromResults(results);
}

async function runUnsync(aliases: string[], options: UnsyncOptions): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  const picked = await selectRepos(repos, aliases, options, "unsync");
  if (!picked || picked.length === 0) return 1;

  const results: OperationResult[] = picked.map((repo) => {
    log.step(`${repo.alias}: unsync`);
    const outcome = unsyncRepo(repo, repoRoot, options.force ?? false);
    if (outcome === "removed") {
      log.success(`${repo.alias}: unsynced`);
      return "unsynced";
    }
    if (outcome === "nothing-to-remove") {
      log.info(`${repo.alias}: nothing to remove`);
      return "unsynced";
    }
    return "failed";
  });

  if (results.length > 1 || options.all) printSummary(results);
  return exitFromResults(results);
}

async function runCheckout(alias: string, branch: string, options: CheckoutOptions): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  const repo = repos.find((r) => r.alias === alias);
  if (!repo) {
    log.error(`Unknown alias "${alias}". Use "oms sync --list" to see registered aliases.`);
    return 1;
  }
  if (!submoduleInitialized(repoRoot, alias)) {
    log.error(`${alias}: not synced. Run "oms sync ${alias}" first.`);
    return 1;
  }

  const dir = aliasDir(repoRoot, alias);
  // Best-effort refresh so an existing remote branch is recognized; offline is fine.
  runSub(repoRoot, alias, ["fetch", "origin", "--quiet"]);

  if (localBranchExists(dir, branch)) {
    log.step(`${alias}: git switch ${branch}`);
    const r = runSub(repoRoot, alias, ["switch", branch], true);
    if (!r.success) return 2;
    log.success(`${alias}: on ${branch}`);
    return 0;
  }
  if (remoteBranchExists(dir, branch)) {
    log.step(`${alias}: git switch -c ${branch} origin/${branch}`);
    const r = runSub(repoRoot, alias, ["switch", "-c", branch, `origin/${branch}`], true);
    if (!r.success) return 2;
    log.success(`${alias}: on ${branch} (tracking origin/${branch})`);
    return 0;
  }

  // Brand-new branch: created locally, no remote precondition. Push later with "oms push".
  const args = ["switch", "-c", branch, ...(options.from ? [options.from] : [])];
  log.step(`${alias}: git ${args.join(" ")}`);
  const r = runSub(repoRoot, alias, args, true);
  if (!r.success) return 2;
  log.success(`${alias}: created new local branch ${branch}. Push it with "oms push ${alias}".`);
  return 0;
}

type StatusRow = {
  alias: string;
  branch: string;
  pin: string;
  dirty: string;
  ahead: string;
  behind: string;
};

/** Parse the leading status char from `git submodule status` (' ' ok, '+' moved, '-' uninit, 'U' conflict). */
function pinState(repoRoot: string, alias: string): string {
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

async function runStatus(aliases: string[], options: SourcesOptions): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  const targets = aliases.length > 0 || options.all
    ? await selectRepos(repos, options.all ? [] : aliases, options.all ? options : {}, "inspect")
    : repos;
  if (!targets) return 1;

  const rows: StatusRow[] = [];
  for (const repo of targets) {
    if (!isRegisteredSubmodule(repoRoot, submodulePath(repo.alias))) {
      rows.push({ alias: repo.alias, branch: "(not registered)", pin: "-", dirty: "", ahead: "", behind: "" });
      continue;
    }
    if (!submoduleInitialized(repoRoot, repo.alias)) {
      rows.push({ alias: repo.alias, branch: "(not synced)", pin: "uninit", dirty: "", ahead: "", behind: "" });
      continue;
    }
    const dir = aliasDir(repoRoot, repo.alias);
    const branch = currentBranch(dir) ?? `(detached ${shortSha(dir)})`;
    const { ahead, behind } = aheadBehind(dir);
    rows.push({
      alias: repo.alias,
      branch,
      pin: pinState(repoRoot, repo.alias),
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

const INIT_TEMPLATE = `# yaml-language-server: $schema=https://raw.githubusercontent.com/divlook/oh-my-space/main/oms.schema.json
repos:
  - alias: example
    remotes:
      origin: git@github.com:example/repo.git
      # upstream: git@github.com:upstream/repo.git
    branch: main
`;

/** 현재 디렉터리에 기본 oms.yaml 템플릿을 생성합니다. */
async function runInit(options: { force?: boolean }): Promise<number> {
  const target = join(process.cwd(), MANIFEST_FILENAME);
  if (existsSync(target) && !options.force) {
    log.error(`${MANIFEST_FILENAME} already exists at ${target}. Use --force to overwrite.`);
    return 1;
  }
  writeFileSync(target, INIT_TEMPLATE);
  log.success(`created ${MANIFEST_FILENAME} at ${target}`);
  // Sources are tracked submodules, so make sure no stale oms version left oms/ ignored.
  ensureOmsNotIgnored(process.cwd());
  if (!isGitRepo(process.cwd())) {
    log.info(`oms manages sources as git submodules; run "git init" here if this is not a git repo yet.`);
  }
  log.info(`edit alias/remotes/branch, then run "oms sync".`);
  return 0;
}

async function runDoctor(): Promise<number> {
  const loaded = loadRepos();
  if (!loaded) {
    emitLegacyRenameHintWalkUp();
    return 1;
  }
  const { repos, repoRoot } = loaded;
  if (abortOnLegacyRenameAt(repoRoot)) return 1;

  log.success(`Workspace root: ${repoRoot}`);
  log.success(`${MANIFEST_FILENAME}: ${repos.length} repo(s) configured`);

  const git = spawnSync("git", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (git.status !== 0) {
    log.error("git: not found");
    return 1;
  }
  log.success(`git: ${git.stdout.trim()}`);

  let warnings = 0;

  const parsed = parseGitVersion(git.stdout);
  if (!parsed) {
    log.warn(
      `git: could not parse version from "${git.stdout.trim()}"; oms expects git >=${MIN_GIT_MAJOR}.${MIN_GIT_MINOR}.`,
    );
    warnings++;
  } else if (!isGitVersionSupported(parsed)) {
    log.warn(
      `git ${parsed.major}.${parsed.minor} is older than the recommended ${MIN_GIT_MAJOR}.${MIN_GIT_MINOR}. oms uses "git switch" and submodule commands which may behave differently on older releases — upgrade git.`,
    );
    warnings++;
  }

  if (!isGitRepo(repoRoot)) {
    log.warn(
      `workspace is not a git repository. oms manages sources as submodules; run "git init" at ${repoRoot}.`,
    );
    warnings++;
  }

  if (abortOnLegacyWorktree(repoRoot, repos)) return 1;

  if (gitignoreIgnoresOms(repoRoot)) {
    log.warn(`.gitignore excludes ${GITIGNORE_ENTRY}, but submodules must be tracked. Run "oms sync" to remove it.`);
    warnings++;
  }

  for (const repo of repos) {
    if (!isRegisteredSubmodule(repoRoot, submodulePath(repo.alias))) {
      log.info(`${repo.alias}: not synced`);
      continue;
    }
    if (!submoduleInitialized(repoRoot, repo.alias)) {
      log.warn(`${repo.alias}: registered but not initialized. Run "oms sync ${repo.alias}".`);
      warnings++;
      continue;
    }
    const dir = aliasDir(repoRoot, repo.alias);
    const branch = currentBranch(dir);
    if (!branch) {
      log.warn(`${repo.alias}: detached HEAD. Run "oms checkout ${repo.alias} <branch>" to get on a branch.`);
      warnings++;
    } else {
      log.success(`${repo.alias}: submodule OK (branch=${branch})`);
    }
    if (pinState(repoRoot, repo.alias) === "moved") {
      log.info(`${repo.alias}: working commit differs from the recorded pointer. Commit oms/${repo.alias} to record it.`);
    }
  }

  return warnings > 0 ? 2 : 0;
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readPackageVersion(): string {
  const pkg = readJson<{ version?: string }>(join(packageRoot, "package.json"));
  return pkg?.version ?? "0.0.0";
}

/** The commit baked in at build time, or null when unavailable (dev/no-git build). */
function readBuildCommit(): string | null {
  const info = readJson<{ commit?: string | null }>(
    join(dirname(fileURLToPath(import.meta.url)), "build-info.json"),
  );
  return info?.commit ?? null;
}

/** Clickable GitHub permalink for a repo doc, pinned to the build commit; falls back to the version tag. */
function docUrl(relPath: string): string {
  const ref = readBuildCommit() ?? `v${readPackageVersion()}`;
  return `${DOCS_REPO_BLOB_BASE}/${ref}/${relPath}`;
}

async function exitWith(action: Promise<number>): Promise<void> {
  try {
    process.exit(await action);
  } catch (e) {
    log.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

const exitHelp = "\nExit codes: 0 ok | 1 usage/config error | 2 one or more git operations failed.";
const commandNames = new Set([
  "init",
  "doctor",
  "sync",
  "status",
  "checkout",
  "fetch",
  "pull",
  "push",
  "unsync",
  "help",
]);
const program = new Command();

program
  .name("oms")
  .description(
    `Manage source repositories listed in ${MANIFEST_FILENAME} as git submodules under ${DATA_DIRNAME}/<alias>/.`,
  )
  .version(readPackageVersion())
  .addHelpText("after", exitHelp);

program
  .command("init")
  .description(`Create a starter ${MANIFEST_FILENAME} in the current directory.`)
  .option("--force", `overwrite an existing ${MANIFEST_FILENAME}`)
  .addHelpText("after", exitHelp)
  .action(async (options: { force?: boolean }) => {
    await exitWith(runInit(options));
  });

program
  .command("doctor")
  .description(
    `Check ${MANIFEST_FILENAME}, git availability, and the submodule state of each registered alias.`,
  )
  .addHelpText("after", exitHelp)
  .action(async () => {
    await exitWith(runDoctor());
  });

program
  .command("sync")
  .description(
    `Register each repo as a submodule at ${DATA_DIRNAME}/<alias>/ (or initialize and refresh an existing one), checked out on its baseline branch.`,
  )
  .argument("[aliases...]", "repo aliases to sync (omit for interactive multi-select)")
  .option("--all", "sync every registered source repo")
  .option("--list", "print registered repos")
  .addHelpText("after", exitHelp)
  .action(async (aliases: string[], options: SourcesOptions) => {
    await exitWith(runSync(aliases, options));
  });

program
  .command("status")
  .description("Show each submodule's branch, pointer state, dirtiness, and ahead/behind counts.")
  .argument("[aliases...]", "repo aliases to inspect (omit for all)")
  .option("--all", "inspect every registered source repo")
  .addHelpText("after", exitHelp)
  .action(async (aliases: string[], options: SourcesOptions) => {
    await exitWith(runStatus(aliases, options));
  });

program
  .command("checkout")
  .description(
    "Switch a submodule to <branch>, creating it locally if it does not exist yet (no remote required).",
  )
  .argument("<alias>", "registered source alias")
  .argument("<branch>", "branch name (may include slashes)")
  .option("--from <ref>", "start point for a new branch (default: current HEAD)")
  .addHelpText("after", exitHelp)
  .action(async (alias: string, branch: string, options: CheckoutOptions) => {
    await exitWith(runCheckout(alias, branch, options));
  });

const collectRemote = (value: string, acc: string[]): string[] => [...acc, value];

program
  .command("fetch")
  .description("Run git fetch <remote> --prune in each submodule (defaults to origin).")
  .argument("[aliases...]", "repo aliases to fetch (omit for interactive multi-select)")
  .option("--all", "fetch every registered source repo")
  .option("--remote <name>", "remote to fetch (repeatable; omit to choose interactively)", collectRemote, [])
  .addHelpText("after", exitHelp)
  .action(async (aliases: string[], options: SourcesOptions & RemoteOptions) => {
    await exitWith(runManage("fetch", aliases, options));
  });

program
  .command("pull")
  .description(
    "Run git pull --ff-only <remote> on each submodule's current branch and stage the moved pointer (defaults to origin).",
  )
  .argument("[aliases...]", "repo aliases to pull (omit for interactive multi-select)")
  .option("--all", "pull every registered source repo")
  .option("--remote <name>", "remote to pull from (single; omit to choose interactively)", collectRemote, [])
  .addHelpText("after", exitHelp)
  .action(async (aliases: string[], options: SourcesOptions & RemoteOptions) => {
    await exitWith(runManage("pull", aliases, options));
  });

program
  .command("push")
  .description(
    "Run git push <remote> <branch> on each listed submodule (creating the remote branch on first push) and stage the moved pointer (defaults to origin).",
  )
  .argument("<aliases...>", "repo aliases to push")
  .option("--commit", "also commit the pointer update in the parent repo")
  .option("--remote <name>", "remote to push to (repeatable; omit to choose interactively)", collectRemote, [])
  .addHelpText("after", exitHelp)
  .action(async (aliases: string[], options: PushOptions & RemoteOptions) => {
    await exitWith(runManage("push", aliases, options));
  });

program
  .command("unsync")
  .description(
    `Deinitialize and remove the submodule for each alias (keeps ${MANIFEST_FILENAME} entry).`,
  )
  .argument("[aliases...]", "repo aliases to unsync (omit for interactive multi-select)")
  .option("--all", "unsync every registered source repo")
  .option("--force", "discard uncommitted changes in the submodule")
  .addHelpText("after", exitHelp)
  .action(async (aliases: string[], options: UnsyncOptions) => {
    await exitWith(runUnsync(aliases, options));
  });

const requestedCommand = process.argv[2];
if (requestedCommand && !requestedCommand.startsWith("-") && !commandNames.has(requestedCommand)) {
  console.error(`error: unknown command '${requestedCommand}'`);
  process.exit(1);
}

await program.parseAsync();
