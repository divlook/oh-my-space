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
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { cancel, isCancel, log, multiselect } from "@clack/prompts";
import { parse as parseYaml } from "yaml";

type Repo = {
  alias: string;
  url: string;
  branch?: string;
};

type SourcesOptions = {
  all?: boolean;
  list?: boolean;
};

type UnsyncOptions = SourcesOptions & {
  force?: boolean;
};

type WorktreeRemoveOptions = {
  force?: boolean;
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

type WorktreeEntry = {
  /** branch short name, or "(detached)" if no branch */
  branch: string;
  /** absolute path */
  path: string;
  /** path relative to sources/<alias>/ */
  relativePath: string;
};

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const ALLOWED_TOP_KEYS = new Set(["repos"]);
const ALLOWED_ITEM_KEYS = new Set(["alias", "url", "branch"]);
const FETCH_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";
const GITIGNORE_ENTRY = "sources/";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const useColor = process.stdout.isTTY;
const dim = (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);

function validateSources(data: unknown): Repo[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("sources.yaml: root must be a mapping");
  }
  const obj = data as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_TOP_KEYS.has(key)) {
      throw new Error(`sources.yaml: unknown top-level key "${key}"`);
    }
  }
  const { repos } = obj;
  if (!Array.isArray(repos)) {
    throw new Error('sources.yaml: "repos" must be an array');
  }
  if (repos.length === 0) {
    throw new Error('sources.yaml: "repos" must have at least one item');
  }

  const validated: Repo[] = [];
  const seen = new Set<string>();

  repos.forEach((item, idx) => {
    const where = `repos[${idx}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`sources.yaml: ${where} must be a mapping`);
    }
    const r = item as Record<string, unknown>;
    for (const key of Object.keys(r)) {
      if (!ALLOWED_ITEM_KEYS.has(key)) {
        throw new Error(`sources.yaml: ${where} has unknown key "${key}"`);
      }
    }
    if (typeof r.alias !== "string" || r.alias.length === 0) {
      throw new Error(`sources.yaml: ${where} missing required "alias"`);
    }
    if (!ALIAS_PATTERN.test(r.alias)) {
      throw new Error(
        `sources.yaml: ${where}.alias "${r.alias}" must match ${ALIAS_PATTERN}`,
      );
    }
    if (seen.has(r.alias)) {
      throw new Error(`sources.yaml: duplicate alias "${r.alias}"`);
    }
    seen.add(r.alias);
    if (typeof r.url !== "string" || r.url.length === 0) {
      throw new Error(`sources.yaml: ${where} missing required "url"`);
    }
    let branch: string | undefined;
    if (r.branch !== undefined) {
      if (typeof r.branch !== "string" || r.branch.length === 0) {
        throw new Error(`sources.yaml: ${where}.branch must be a non-empty string`);
      }
      branch = r.branch;
    }
    validated.push({ alias: r.alias, url: r.url, branch });
  });

  return validated;
}

function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - s.length));
}

function printList(repos: Repo[]): void {
  const aliasW = Math.max("ALIAS".length, ...repos.map((r) => r.alias.length));
  const urlW = Math.max("URL".length, ...repos.map((r) => r.url.length));
  console.log(dim(`${pad("ALIAS", aliasW)}  ${pad("URL", urlW)}  BRANCH`));
  for (const r of repos) {
    console.log(`${pad(r.alias, aliasW)}  ${pad(r.url, urlW)}  ${r.branch ?? ""}`);
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

/** Run git from sources/<alias>/ with safe.bareRepository=all, so the .git placeholder routes to .bare. */
function runBareGit(
  repoRoot: string,
  alias: string,
  args: string[],
  inheritOutput = false,
): GitResult {
  return runGit(
    aliasDir(repoRoot, alias),
    ["-c", "safe.bareRepository=all", ...args],
    inheritOutput,
  );
}

function findWorkspaceRoot(options: WorkspaceOptions = {}): string | null {
  let current = resolve(options.cwd ?? process.cwd());
  while (true) {
    if (existsSync(join(current, "sources.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function aliasDir(repoRoot: string, alias: string): string {
  return join(repoRoot, "sources", alias);
}

function bareDir(repoRoot: string, alias: string): string {
  return join(aliasDir(repoRoot, alias), ".bare");
}

function gitPlaceholderPath(repoRoot: string, alias: string): string {
  return join(aliasDir(repoRoot, alias), ".git");
}

function worktreePath(repoRoot: string, alias: string, branch: string): string {
  return join(aliasDir(repoRoot, alias), branch);
}

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

/** Returns true when .gitmodules registers any sources/<alias> entry for the loaded repos. */
function hasLegacySubmoduleLayout(repoRoot: string, repos: Repo[]): boolean {
  if (!existsSync(join(repoRoot, ".gitmodules"))) return false;
  return repos.some((repo) => isRegisteredSubmodule(repoRoot, `sources/${repo.alias}`));
}

function abortOnLegacy(repoRoot: string, repos: Repo[]): boolean {
  if (!hasLegacySubmoduleLayout(repoRoot, repos)) return false;
  log.error(
    'detected legacy submodule layout (.gitmodules registers sources/<alias>). oh-my-space 0.3.0 uses bare clone + worktrees.\n' +
      '  See README "Migrating from 0.2.x" for the manual steps. Aborting to avoid destructive change.',
  );
  return true;
}

function ensureGitignore(repoRoot: string): void {
  const path = join(repoRoot, ".gitignore");
  let content = "";
  if (existsSync(path)) {
    content = readFileSync(path, "utf8");
    const present = content
      .split("\n")
      .some((line) => line.trim() === GITIGNORE_ENTRY || line.trim() === `/${GITIGNORE_ENTRY}`);
    if (present) return;
  }
  const needsNewline = content.length > 0 && !content.endsWith("\n");
  writeFileSync(path, `${content}${needsNewline ? "\n" : ""}${GITIGNORE_ENTRY}\n`);
  log.info(`added ${GITIGNORE_ENTRY} to .gitignore`);
}

function setupBareRepo(repo: Repo, repoRoot: string): boolean {
  const alias = repo.alias;
  const aliasPath = aliasDir(repoRoot, alias);
  const barePath = bareDir(repoRoot, alias);

  mkdirSync(aliasPath, { recursive: true });

  const relBare = relative(repoRoot, barePath);
  log.step(`git clone --bare ${repo.url} ${relBare}`);
  const clone = runGit(repoRoot, ["clone", "--bare", repo.url, relBare], true);
  if (!clone.success) {
    log.error(`${alias}: git clone --bare failed (exit ${clone.exitCode})`);
    if (existsSync(barePath)) rmSync(barePath, { recursive: true, force: true });
    return false;
  }

  // Write the placeholder before any further runBareGit calls, otherwise git ascends
  // out of sources/<alias>/ looking for a repo and touches the wrong .git.
  writeFileSync(gitPlaceholderPath(repoRoot, alias), "gitdir: ./.bare\n");

  const config = runBareGit(repoRoot, alias, [
    "config",
    "remote.origin.fetch",
    FETCH_REFSPEC,
  ]);
  if (!config.success) {
    log.error(`${alias}: failed to set remote.origin.fetch (exit ${config.exitCode})`);
    return false;
  }

  log.step(`${alias}: git fetch origin`);
  const fetch = runBareGit(repoRoot, alias, ["fetch", "origin", "--prune"], true);
  if (!fetch.success) {
    log.error(`${alias}: initial fetch failed (exit ${fetch.exitCode})`);
    return false;
  }

  return true;
}

function detectDefaultBranch(repoRoot: string, alias: string): string | null {
  const r = runBareGit(repoRoot, alias, ["symbolic-ref", "--short", "HEAD"]);
  if (r.success) {
    const out = r.stdout.trim();
    return out.length > 0 ? out : null;
  }
  return null;
}

function listExistingWorktrees(repoRoot: string, alias: string): WorktreeEntry[] {
  if (!existsSync(bareDir(repoRoot, alias))) return [];
  const result = runBareGit(repoRoot, alias, ["worktree", "list", "--porcelain"]);
  if (!result.success) return [];

  const aliasPath = aliasDir(repoRoot, alias);
  const entries: WorktreeEntry[] = [];
  const blocks = result.stdout
    .split(/\n\n+/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  for (const block of blocks) {
    let path = "";
    let branch = "(detached)";
    let bare = false;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line.startsWith("branch ")) {
        branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      } else if (line === "bare") bare = true;
    }
    if (!path || bare) continue;
    const rel = relative(aliasPath, path);
    // Skip worktrees outside sources/<alias>/ (shouldn't happen, but be safe)
    if (rel.startsWith("..")) continue;
    entries.push({ branch, path, relativePath: rel });
  }
  return entries;
}

function cleanupEmptyParents(repoRoot: string, alias: string, branch: string): void {
  const parts = branch.split("/").filter((p) => p.length > 0);
  if (parts.length < 2) return;
  for (let i = parts.length - 1; i >= 1; i--) {
    const dirPath = join(aliasDir(repoRoot, alias), ...parts.slice(0, i));
    try {
      const entries = readdirSync(dirPath);
      if (entries.length === 0) {
        rmdirSync(dirPath);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}

function addWorktree(repo: Repo, repoRoot: string, branch: string): boolean {
  const wtPath = worktreePath(repoRoot, repo.alias, branch);
  if (existsSync(wtPath)) {
    log.warn(`${repo.alias}: sources/${repo.alias}/${branch} already exists; skipping.`);
    return true;
  }

  log.step(`${repo.alias}: git worktree add --track -B ${branch} ${branch} origin/${branch}`);
  const result = runBareGit(
    repoRoot,
    repo.alias,
    ["worktree", "add", "--track", "-B", branch, branch, `origin/${branch}`],
    true,
  );
  if (!result.success) {
    log.error(`${repo.alias}: worktree add for ${branch} failed (exit ${result.exitCode})`);
    cleanupEmptyParents(repoRoot, repo.alias, branch);
    return false;
  }
  return true;
}

function removeWorktree(
  repo: Repo,
  repoRoot: string,
  branch: string,
  force: boolean,
): boolean {
  const wtPath = worktreePath(repoRoot, repo.alias, branch);
  if (!existsSync(wtPath)) return true;

  const args = ["worktree", "remove", ...(force ? ["--force"] : []), branch];
  log.step(`${repo.alias}: git worktree remove ${branch}${force ? " --force" : ""}`);
  const result = runBareGit(repoRoot, repo.alias, args, true);
  if (!result.success) {
    log.error(
      `${repo.alias}: worktree remove for ${branch} failed (exit ${result.exitCode})`,
    );
    return false;
  }
  cleanupEmptyParents(repoRoot, repo.alias, branch);
  return true;
}

function syncRepo(repo: Repo, repoRoot: string): OperationResult {
  const alias = repo.alias;
  const aliasPath = aliasDir(repoRoot, alias);
  const barePath = bareDir(repoRoot, alias);
  const placeholderPath = gitPlaceholderPath(repoRoot, alias);
  const bareExists = existsSync(barePath);

  if (!bareExists) {
    if (existsSync(aliasPath)) {
      const stray = readdirSync(aliasPath).filter((e) => e !== ".git");
      if (stray.length > 0) {
        log.error(
          `${alias}: sources/${alias}/ already exists but is not a bare clone. Move or remove it manually, then retry.`,
        );
        return "failed";
      }
    }

    if (repo.branch) {
      const lsRemote = runGit(repoRoot, [
        "ls-remote",
        "--exit-code",
        "--heads",
        repo.url,
        repo.branch,
      ]);
      if (lsRemote.exitCode === 2) {
        log.error(
          `${alias}: branch "${repo.branch}" not found on ${repo.url}. Push the branch upstream or fix the alias, then retry.`,
        );
        return "failed";
      }
      if (!lsRemote.success && lsRemote.exitCode !== 2) {
        log.warn(
          `${alias}: branch existence check failed (exit ${lsRemote.exitCode}); proceeding.`,
        );
      }
    }

    if (!setupBareRepo(repo, repoRoot)) {
      if (existsSync(barePath)) rmSync(barePath, { recursive: true, force: true });
      if (existsSync(placeholderPath)) rmSync(placeholderPath);
      try {
        if (readdirSync(aliasPath).length === 0) rmdirSync(aliasPath);
      } catch {}
      return "failed";
    }

    const branch = repo.branch ?? detectDefaultBranch(repoRoot, alias);
    if (!branch) {
      log.error(
        `${alias}: could not determine default branch from bare clone. Set "branch:" in sources.yaml.`,
      );
      return "failed";
    }
    if (!addWorktree(repo, repoRoot, branch)) return "failed";
    log.success(`${alias}: added (branch=${branch})`);
    return "added";
  }

  if (!existsSync(placeholderPath)) {
    writeFileSync(placeholderPath, "gitdir: ./.bare\n");
  }

  log.step(`${alias}: git fetch origin`);
  const fetch = runBareGit(repoRoot, alias, ["fetch", "origin", "--prune"], true);
  if (!fetch.success) {
    log.error(`${alias}: fetch failed (exit ${fetch.exitCode})`);
    return "failed";
  }

  const branch = repo.branch ?? detectDefaultBranch(repoRoot, alias);
  if (branch && !existsSync(worktreePath(repoRoot, alias, branch))) {
    if (!addWorktree(repo, repoRoot, branch)) return "failed";
  }

  runBareGit(repoRoot, alias, ["worktree", "prune"]);
  log.success(`${alias}: updated`);
  return "updated";
}

function unsyncRepo(repo: Repo, repoRoot: string, force: boolean): RemoveOutcome {
  const aliasPath = aliasDir(repoRoot, repo.alias);
  const barePath = bareDir(repoRoot, repo.alias);
  const placeholderPath = gitPlaceholderPath(repoRoot, repo.alias);

  const aliasExists = existsSync(aliasPath);
  const bareExists = existsSync(barePath);

  if (!aliasExists && !bareExists) return "nothing-to-remove";

  const worktrees = bareExists ? listExistingWorktrees(repoRoot, repo.alias) : [];

  if (!force) {
    for (const wt of worktrees) {
      const status = runGit(wt.path, ["status", "--porcelain"]);
      if (status.success && status.stdout.trim().length > 0) {
        log.error(
          `${repo.alias}: worktree at sources/${repo.alias}/${wt.relativePath} has uncommitted changes. Commit, stash, or pass --force.`,
        );
        return "failed";
      }
    }
  }

  for (const wt of worktrees) {
    const target = wt.branch === "(detached)" ? wt.relativePath : wt.branch;
    if (!removeWorktree(repo, repoRoot, target, force)) {
      return "failed";
    }
  }

  if (existsSync(barePath)) rmSync(barePath, { recursive: true, force: true });
  if (existsSync(placeholderPath)) rmSync(placeholderPath);

  try {
    if (existsSync(aliasPath)) {
      const remaining = readdirSync(aliasPath);
      if (remaining.length === 0) rmdirSync(aliasPath);
    }
  } catch {}

  return "removed";
}

function fetchRepo(repo: Repo, repoRoot: string): OperationResult {
  if (!existsSync(bareDir(repoRoot, repo.alias))) {
    log.error(`${repo.alias}: not synced. Run "oms sync ${repo.alias}" first.`);
    return "failed";
  }
  log.step(`${repo.alias}: git fetch origin --prune`);
  const r = runBareGit(repoRoot, repo.alias, ["fetch", "origin", "--prune"], true);
  if (r.success) {
    log.success(`${repo.alias}: fetched`);
    return "fetched";
  }
  log.error(`${repo.alias}: fetch failed (exit ${r.exitCode})`);
  return "failed";
}

function resolveTargetWorktree(
  repo: Repo,
  repoRoot: string,
): { branch: string; path: string } | null {
  const defaultBranch = repo.branch ?? detectDefaultBranch(repoRoot, repo.alias);
  if (defaultBranch) {
    const path = worktreePath(repoRoot, repo.alias, defaultBranch);
    if (existsSync(path)) return { branch: defaultBranch, path };
  }
  const wts = listExistingWorktrees(repoRoot, repo.alias);
  if (wts.length === 1) {
    const only = wts[0];
    return { branch: only.branch === "(detached)" ? only.relativePath : only.branch, path: only.path };
  }
  return null;
}

function pullRepo(repo: Repo, repoRoot: string): OperationResult {
  if (!existsSync(bareDir(repoRoot, repo.alias))) {
    log.error(`${repo.alias}: not synced. Run "oms sync ${repo.alias}" first.`);
    return "failed";
  }
  const target = resolveTargetWorktree(repo, repoRoot);
  if (!target) {
    log.error(
      `${repo.alias}: cannot determine which worktree to pull. Use "oms worktree list ${repo.alias}".`,
    );
    return "failed";
  }
  log.step(`${repo.alias}/${target.branch}: git pull --ff-only`);
  const r = runGit(target.path, ["pull", "--ff-only"], true);
  if (r.success) {
    log.success(`${repo.alias}/${target.branch}: pulled`);
    return "pulled";
  }
  log.error(`${repo.alias}/${target.branch}: pull failed (exit ${r.exitCode})`);
  return "failed";
}

function pushRepo(repo: Repo, repoRoot: string): OperationResult {
  if (!existsSync(bareDir(repoRoot, repo.alias))) {
    log.error(`${repo.alias}: not synced. Run "oms sync ${repo.alias}" first.`);
    return "failed";
  }
  const target = resolveTargetWorktree(repo, repoRoot);
  if (!target) {
    log.error(
      `${repo.alias}: cannot determine which worktree to push. Use "oms worktree list ${repo.alias}".`,
    );
    return "failed";
  }
  const upstream = runGit(target.path, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);
  if (!upstream.success) {
    log.error(
      `${repo.alias}/${target.branch}: git push requires an upstream. Set it manually before pushing.`,
    );
    return "failed";
  }
  log.step(`${repo.alias}/${target.branch}: git push`);
  const r = runGit(
    target.path,
    ["-c", "push.autoSetupRemote=false", "push"],
    true,
  );
  if (r.success) {
    log.success(`${repo.alias}/${target.branch}: pushed`);
    return "pushed";
  }
  log.error(`${repo.alias}/${target.branch}: push failed (exit ${r.exitCode})`);
  return "failed";
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
      "Could not find sources.yaml in the current directory or its parents. Create a sources.yaml in this project, then retry.",
    );
    return null;
  }

  try {
    const sourcesPath = join(repoRoot, "sources.yaml");
    return { repos: validateSources(parseYaml(readFileSync(sourcesPath, "utf8"))), repoRoot };
  } catch (e) {
    log.error(e instanceof Error ? e.message : String(e));
    return null;
  }
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
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  if (options.list) {
    printList(repos);
    return 0;
  }

  if (abortOnLegacy(repoRoot, repos)) return 1;

  const picked = await selectRepos(repos, aliases, options, "sync");
  if (!picked || picked.length === 0) return 1;

  ensureGitignore(repoRoot);

  const results = picked.map((repo) => syncRepo(repo, repoRoot));
  if (results.length > 1 || options.all) printSummary(results);
  return exitFromResults(results);
}

async function runManage(
  command: ManageCommand,
  aliases: string[],
  options: SourcesOptions,
): Promise<number> {
  const loaded = loadRepos();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;
  if (abortOnLegacy(repoRoot, repos)) return 1;

  const picked = await selectRepos(repos, aliases, options, command);
  if (!picked || picked.length === 0) return 1;

  const fn = command === "fetch" ? fetchRepo : command === "pull" ? pullRepo : pushRepo;
  const results = picked.map((repo) => fn(repo, repoRoot));
  if (results.length > 1 || options.all) printSummary(results);
  return exitFromResults(results);
}

async function runUnsync(aliases: string[], options: UnsyncOptions): Promise<number> {
  const loaded = loadRepos();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;
  if (abortOnLegacy(repoRoot, repos)) return 1;

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

async function runWorktreeAdd(alias: string, branch: string): Promise<number> {
  const loaded = loadRepos();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;
  if (abortOnLegacy(repoRoot, repos)) return 1;

  const repo = repos.find((r) => r.alias === alias);
  if (!repo) {
    log.error(`Unknown alias "${alias}". Use "oms sync --list" to see registered aliases.`);
    return 1;
  }
  if (!existsSync(bareDir(repoRoot, alias))) {
    log.error(`${alias}: not synced. Run "oms sync ${alias}" first.`);
    return 1;
  }
  if (existsSync(worktreePath(repoRoot, alias, branch))) {
    log.error(`${alias}: worktree for ${branch} already exists at sources/${alias}/${branch}.`);
    return 1;
  }

  log.step(`${alias}: git fetch origin --prune (refresh before add)`);
  runBareGit(repoRoot, alias, ["fetch", "origin", "--prune"], true);

  if (!addWorktree(repo, repoRoot, branch)) return 2;
  log.success(`${alias}: added worktree for ${branch}`);
  return 0;
}

async function runWorktreeList(alias: string | undefined): Promise<number> {
  const loaded = loadRepos();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;
  if (abortOnLegacy(repoRoot, repos)) return 1;

  const targets = alias ? repos.filter((r) => r.alias === alias) : repos;
  if (alias && targets.length === 0) {
    log.error(`Unknown alias "${alias}".`);
    return 1;
  }

  const rows: Array<{ alias: string; branch: string; path: string }> = [];
  for (const repo of targets) {
    if (!existsSync(bareDir(repoRoot, repo.alias))) {
      rows.push({ alias: repo.alias, branch: "(not synced)", path: "-" });
      continue;
    }
    const wts = listExistingWorktrees(repoRoot, repo.alias);
    if (wts.length === 0) {
      rows.push({ alias: repo.alias, branch: "(no worktrees)", path: "-" });
      continue;
    }
    for (const wt of wts) {
      rows.push({
        alias: repo.alias,
        branch: wt.branch,
        path: `sources/${repo.alias}/${wt.relativePath}`,
      });
    }
  }

  const aliasW = Math.max("ALIAS".length, ...rows.map((r) => r.alias.length));
  const branchW = Math.max("BRANCH".length, ...rows.map((r) => r.branch.length));
  console.log(dim(`${pad("ALIAS", aliasW)}  ${pad("BRANCH", branchW)}  PATH`));
  for (const r of rows) {
    console.log(`${pad(r.alias, aliasW)}  ${pad(r.branch, branchW)}  ${r.path}`);
  }
  return 0;
}

async function runWorktreeRemove(
  alias: string,
  branch: string,
  options: WorktreeRemoveOptions,
): Promise<number> {
  const loaded = loadRepos();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;
  if (abortOnLegacy(repoRoot, repos)) return 1;

  const repo = repos.find((r) => r.alias === alias);
  if (!repo) {
    log.error(`Unknown alias "${alias}".`);
    return 1;
  }

  const wtPath = worktreePath(repoRoot, alias, branch);
  if (!existsSync(wtPath)) {
    log.info(`${alias}: no worktree for ${branch}`);
    return 0;
  }

  if (!options.force) {
    const status = runGit(wtPath, ["status", "--porcelain"]);
    if (status.success && status.stdout.trim().length > 0) {
      log.error(
        `${alias}/${branch}: has uncommitted changes. Commit, stash, or pass --force.`,
      );
      return 2;
    }
  }

  if (!removeWorktree(repo, repoRoot, branch, options.force ?? false)) return 2;
  log.success(`${alias}: removed worktree for ${branch}`);
  return 0;
}

async function runDoctor(): Promise<number> {
  const loaded = loadRepos();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  log.success(`Workspace root: ${repoRoot}`);
  log.success(`sources.yaml: ${repos.length} repo(s) configured`);

  const git = spawnSync("git", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (git.status === 0) {
    log.success(`git: ${git.stdout.trim()}`);
  } else {
    log.error("git: not found");
    return 1;
  }

  let warnings = 0;

  if (hasLegacySubmoduleLayout(repoRoot, repos)) {
    log.warn(
      'detected legacy submodule layout (.gitmodules registers sources/<alias>). See README "Migrating from 0.2.x".',
    );
    warnings++;
  }

  const gi = join(repoRoot, ".gitignore");
  const giHasSources = existsSync(gi)
    && readFileSync(gi, "utf8")
      .split("\n")
      .some((l) => l.trim() === GITIGNORE_ENTRY || l.trim() === `/${GITIGNORE_ENTRY}`);
  if (!giHasSources) {
    log.warn(`.gitignore does not exclude ${GITIGNORE_ENTRY}. Run "oms sync" to add it automatically.`);
    warnings++;
  }

  for (const repo of repos) {
    const bare = bareDir(repoRoot, repo.alias);
    if (!existsSync(bare)) {
      log.info(`${repo.alias}: not synced`);
      continue;
    }
    const refspec = runBareGit(repoRoot, repo.alias, ["config", "--get", "remote.origin.fetch"]);
    if (!refspec.success || refspec.stdout.trim().length === 0) {
      log.warn(
        `${repo.alias}: bare clone is missing remote.origin.fetch. Run: git -C sources/${repo.alias}/.bare -c safe.bareRepository=all config remote.origin.fetch '${FETCH_REFSPEC}'`,
      );
      warnings++;
    } else {
      log.success(`${repo.alias}: bare clone OK (refspec: ${refspec.stdout.trim()})`);
    }
    if (!existsSync(gitPlaceholderPath(repoRoot, repo.alias))) {
      log.warn(
        `${repo.alias}: missing .git placeholder at sources/${repo.alias}/.git. Recreate with: echo 'gitdir: ./.bare' > sources/${repo.alias}/.git`,
      );
      warnings++;
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
  "doctor",
  "sync",
  "fetch",
  "pull",
  "push",
  "unsync",
  "worktree",
  "help",
]);
const program = new Command();

program
  .name("oms")
  .description(
    "Manage source repositories listed in sources.yaml as bare clones + worktrees under sources/<alias>/.",
  )
  .version(readPackageVersion())
  .addHelpText("after", exitHelp);

program
  .command("doctor")
  .description(
    "Check sources.yaml, git availability, bare-clone state, and .gitignore for each registered alias.",
  )
  .addHelpText("after", exitHelp)
  .action(async () => {
    await exitWith(runDoctor());
  });

program
  .command("sync")
  .description(
    "Bare-clone each registered repo into sources/<alias>/.bare and create the baseline worktree at sources/<alias>/<branch>/.",
  )
  .argument("[aliases...]", "repo aliases to sync (omit for interactive multi-select)")
  .option("--all", "sync every registered source repo")
  .option("--list", "print registered repos")
  .addHelpText("after", exitHelp)
  .action(async (aliases: string[], options: SourcesOptions) => {
    await exitWith(runSync(aliases, options));
  });

program
  .command("fetch")
  .description("Run git fetch origin --prune in each bare clone.")
  .argument("[aliases...]", "repo aliases to fetch (omit for interactive multi-select)")
  .option("--all", "fetch every registered source repo")
  .addHelpText("after", exitHelp)
  .action(async (aliases: string[], options: SourcesOptions) => {
    await exitWith(runManage("fetch", aliases, options));
  });

program
  .command("pull")
  .description(
    "Run git pull --ff-only in the baseline worktree of each selected alias; requires upstream.",
  )
  .argument("[aliases...]", "repo aliases to pull (omit for interactive multi-select)")
  .option("--all", "pull every registered source repo")
  .addHelpText("after", exitHelp)
  .action(async (aliases: string[], options: SourcesOptions) => {
    await exitWith(runManage("pull", aliases, options));
  });

program
  .command("push")
  .description(
    "Run git push in the baseline worktree of each explicitly listed alias; no --all, force, or upstream setup.",
  )
  .argument("<aliases...>", "repo aliases to push")
  .addHelpText("after", exitHelp)
  .action(async (aliases: string[]) => {
    await exitWith(runManage("push", aliases, {}));
  });

program
  .command("unsync")
  .description(
    "Remove all worktrees and the bare clone for each alias (keeps sources.yaml entry).",
  )
  .argument("[aliases...]", "repo aliases to unsync (omit for interactive multi-select)")
  .option("--all", "unsync every registered source repo")
  .option("--force", "discard uncommitted changes in worktrees")
  .addHelpText("after", exitHelp)
  .action(async (aliases: string[], options: UnsyncOptions) => {
    await exitWith(runUnsync(aliases, options));
  });

const worktreeCmd = program
  .command("worktree")
  .description("Manage additional worktrees for a synced source repo.")
  .addHelpText("after", exitHelp);

worktreeCmd
  .command("add")
  .description("Create a worktree for <branch> at sources/<alias>/<branch>/.")
  .argument("<alias>", "registered source alias")
  .argument("<branch>", "branch name (may include slashes)")
  .addHelpText("after", exitHelp)
  .action(async (alias: string, branch: string) => {
    await exitWith(runWorktreeAdd(alias, branch));
  });

worktreeCmd
  .command("list")
  .description("List existing worktrees for the given alias (or all aliases).")
  .argument("[alias]", "registered source alias")
  .addHelpText("after", exitHelp)
  .action(async (alias: string | undefined) => {
    await exitWith(runWorktreeList(alias));
  });

worktreeCmd
  .command("remove")
  .description("Remove the worktree at sources/<alias>/<branch>.")
  .argument("<alias>", "registered source alias")
  .argument("<branch>", "branch name (may include slashes)")
  .option("--force", "discard uncommitted changes")
  .addHelpText("after", exitHelp)
  .action(async (alias: string, branch: string, options: WorktreeRemoveOptions) => {
    await exitWith(runWorktreeRemove(alias, branch, options));
  });

const requestedCommand = process.argv[2];
if (requestedCommand && !requestedCommand.startsWith("-") && !commandNames.has(requestedCommand)) {
  console.error(`error: unknown command '${requestedCommand}'`);
  process.exit(1);
}

await program.parseAsync();
