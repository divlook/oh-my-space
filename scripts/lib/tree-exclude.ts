import { log } from "@clack/prompts";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GITIGNORE_COMMENT, TREE_EXCLUDE_ENTRY } from "./constants.js";
import { productionGitRunner, runGit, type RawGitRunner } from "./git.js";

export function appendLocalExcludeEntry(content: string): string | null {
  const hasEntry = content
    .split("\n")
    .some((line) => line.trim() === TREE_EXCLUDE_ENTRY || line.trim() === `/${TREE_EXCLUDE_ENTRY}`);
  if (hasEntry) return null;
  const base = content.replace(/\n+$/, "");
  return `${base.length > 0 ? `${base}\n` : ""}${GITIGNORE_COMMENT}\n${TREE_EXCLUDE_ENTRY}\n`;
}

function rootLocalExcludePath(repoRoot: string, runner: RawGitRunner = productionGitRunner): string | null {
  const dotGit = join(repoRoot, ".git");
  let stat;
  try {
    stat = statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return join(dotGit, "info", "exclude");
  const result = runGit(repoRoot, ["rev-parse", "--git-path", "info/exclude"], false, undefined, runner);
  if (!result.success) return null;
  return resolve(repoRoot, result.stdout.trim());
}

export function rootExcludeEntryPresent(repoRoot: string, runner: RawGitRunner = productionGitRunner): boolean | null {
  const path = rootLocalExcludePath(repoRoot, runner);
  if (path === null) return null;
  if (!existsSync(path)) return false;
  const next = appendLocalExcludeEntry(readFileSync(path, "utf8"));
  return next === null;
}

export function ensureTreeExcluded(repoRoot: string, runner: RawGitRunner = productionGitRunner): void {
  const path = rootLocalExcludePath(repoRoot, runner);
  if (path === null) {
    log.warn("could not locate the root's local exclude file; .oms-tree/ may show as untracked in git status.");
    return;
  }
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const next = appendLocalExcludeEntry(existing);
  if (next === null) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
}


