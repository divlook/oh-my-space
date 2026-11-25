import { linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "@clack/prompts";
import { redactSensitiveUrls } from "./git.js";
import { updateLocalExclude } from "./local-exclude.js";
import { loadRepos } from "./manifest.js";
import { printList, selectRepos } from "./prompts.js";
import { inspectSourceCheckout, matchingOrigin, openSourceWorkspace, type SourceWorkspace } from "./source-checkout.js";
import type { Repo, SourcesOptions } from "./types.js";

function rootIgnoreMatch(workspace: SourceWorkspace, relative: string): string {
  const result = workspace.git(workspace.root, ["check-ignore", "--no-index", "--verbose", "--non-matching", "-z", "--stdin"], Buffer.from(`${relative}\0`));
  const [source, , pattern, path] = result.stdout.split("\0");
  if ((result.exitCode !== 0 && result.exitCode !== 1) || path !== relative) {
    throw new Error(`could not inspect the workspace ignore rules for ${relative}`);
  }
  if (pattern.startsWith("!")) throw new Error(`${source} has an ignore exception for ${relative}; resolve it before cloning`);
  return pattern;
}

function ensureSourceIgnored(workspace: SourceWorkspace, relative: string): void {
  if (rootIgnoreMatch(workspace, relative)) return;
  const updated = updateLocalExclude(workspace.commonDir, 0o644, (before) => {
    if (rootIgnoreMatch(workspace, relative)) return null;
    return [before, `${before.length && before[before.length - 1] !== 10 ? "\n" : ""}/${relative}/\n`];
  });
  if (updated && !rootIgnoreMatch(workspace, relative)) throw new Error(`workspace ignore rules do not cover ${relative}`);
}

function installWorkingFiles(from: string, to: string, topLevel = true): void {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (topLevel && entry.name === ".git") continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(target);
      installWorkingFiles(source, target, false);
    } else if (entry.isSymbolicLink()) {
      symlinkSync(readlinkSync(source), target);
    } else {
      linkSync(source, target);
    }
  }
}

export function cloneSource(workspace: SourceWorkspace, repo: Repo): "existing" | "cloned" {
  const state = inspectSourceCheckout(workspace, repo);
  const relative = `oms/${repo.alias}`;
  if (state.kind === "ready") {
    ensureSourceIgnored(workspace, relative);
    return "existing";
  }
  if (state.kind !== "missing") throw new Error(state.reason);
  const { root, git } = workspace;
  const parent = dirname(state.path);
  try { mkdirSync(parent); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (realpathSync(parent) !== parent) throw new Error(`${parent} is not a canonical directory`);
  const temp = mkdtempSync(join(parent, `.oms-clone-${repo.alias}-`));
  const checkout = join(temp, "checkout");
  let reserved = false;
  try {
    const args = ["clone", "--origin", "origin", "--no-local"];
    if (repo.branch) args.push("--branch", repo.branch);
    const cloned = git(root, [...args, "--", repo.remotes.origin, checkout], null);
    if (!cloned.success) {
      const diagnostic = redactSensitiveUrls(cloned.stderr.trim());
      throw new Error(`git clone failed (exit ${cloned.exitCode})${diagnostic ? `: ${diagnostic}` : ""}`);
    }
    for (const [name, url] of Object.entries(repo.remotes)) {
      if (name === "origin") continue;
      if (!git(checkout, ["remote", "add", "--", name, url]).success) throw new Error(`could not configure remote ${name}`);
    }
    const head = git(checkout, ["symbolic-ref", "--quiet", "HEAD"]);
    if (!head.success || !head.stdout.startsWith("refs/heads/") ||
        (repo.branch && head.stdout !== `refs/heads/${repo.branch}\n`) ||
        !git(checkout, ["rev-parse", "--verify", "HEAD^{commit}"]).success) {
      throw new Error("origin did not provide a usable baseline branch");
    }
    matchingOrigin(git, checkout, repo.remotes.origin);
    const final = inspectSourceCheckout(workspace, repo);
    if (final.kind !== "missing") throw new Error(`destination changed while cloning; ${final.path} was preserved`);
    mkdirSync(state.path);
    reserved = true;
    ensureSourceIgnored(workspace, relative);
    installWorkingFiles(checkout, state.path);
    const targetGit = join(state.path, ".git");
    try {
      lstatSync(targetGit);
      throw new Error(`${targetGit} was created by another process`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    renameSync(join(checkout, ".git"), targetGit);
    return "cloned";
  } catch (error) {
    if (reserved) {
      try { rmdirSync(state.path); reserved = false; } catch {
        // Never remove files from a destination that may have been changed by another process.
      }
    }
    if (reserved) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${reason}. Inspect ${state.path}, move the incomplete directory aside, then retry oms clone ${repo.alias}.`);
    }
    throw error;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export async function runClone(aliases: string[], options: SourcesOptions & { list?: boolean }): Promise<number> {
  const loaded = loadRepos();
  if (!loaded) return 1;
  if (options.list) {
    printList(loaded.repos);
    return 0;
  }
  let workspace: SourceWorkspace;
  try {
    workspace = openSourceWorkspace(loaded.repoRoot);
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const picked = await selectRepos(loaded.repos, aliases, options, "clone");
  if (!picked?.length) return 1;
  let failed = 0;
  for (const repo of picked) {
    try {
      const outcome = cloneSource(workspace, repo);
      log.success(`${repo.alias}: ${outcome === "existing" ? "existing checkout kept unchanged" : "cloned"}`);
    } catch (error) {
      failed++;
      log.error(`${repo.alias}: ${redactSensitiveUrls(error instanceof Error ? error.message : String(error))}`);
    }
  }
  return failed ? 2 : 0;
}
