import type { Dirent } from "node:fs";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { TREE_DIRNAME } from "./constants.js";
import { aliasDir, productionGitRunner, runGit, type RawGitRunner } from "./git.js";
import type { Repo } from "./types.js";

type ManagedTreeState = "healthy" | "broken" | "foreign";

export type ManagedTree = {
  alias: string;
  task: string;
  /** Repository-relative path, e.g. `.oms-tree/api/fix-auth`. */
  path: string;
  absolutePath: string;
  state: ManagedTreeState;
  /** Branch checked out in the tree, or null when detached or unreadable. */
  branch: string | null;
  head: string | null;
  /** Staged, unstaged, and untracked changes present; null when unreadable or not inspected. */
  dirty: boolean | null;
  error: string | null;
  /** Submodule gitdir whose porcelain reported this entry; null for foreign directories. */
  gitdir: string | null;
};

export type PorcelainWorktreeEntry = {
  path: string;
  head: string | null;
  /** Short branch name with the `refs/heads/` prefix stripped; null when detached. */
  branch: string | null;
  /** Prunable reason when Git considers the worktree removable metadata. */
  prunable: string | null;
};

export function treeRelPath(alias: string, task: string): string {
  return `${TREE_DIRNAME}/${alias}/${task}`;
}

/**
 * Parse `git worktree list --porcelain` records. Blank lines separate records; `detached`, `bare`,
 * and `locked` lines carry no decision-relevant state here. Tolerates a missing trailing newline.
 */
export function parseWorktreePorcelain(output: string): PorcelainWorktreeEntry[] {
  const entries: PorcelainWorktreeEntry[] = [];
  let current: PorcelainWorktreeEntry | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length).trim(), head: null, branch: null, prunable: null };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length).trim();
    else if (line.startsWith("branch ")) current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    else if (line.startsWith("prunable ")) current.prunable = line.slice("prunable ".length).trim();
  }
  if (current) entries.push(current);
  return entries;
}

/**
 * Extract the `<alias>/<task>` key from a porcelain path. Matching is suffix-based, so a prunable
 * entry recorded at a pre-relocation path still matches the tree's current on-disk location.
 */
export function managedTreePathKey(absolutePath: string): { alias: string; task: string } | null {
  const match = absolutePath.match(/(?:^|\/)\.oms-tree\/([^/]+)\/([^/]+)$/);
  return match ? { alias: match[1], task: match[2] } : null;
}

function readGitdirLink(path: string): string | null {
  try {
    const match = readFileSync(path, "utf8").trim().match(/^gitdir:\s*(\S.*)$/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function submoduleGitDir(repoRoot: string, alias: string): string | null {
  const dotGit = join(aliasDir(repoRoot, alias), ".git");
  let stat;
  try {
    stat = statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return dotGit;
  const link = readGitdirLink(dotGit);
  return link ? resolve(dirname(dotGit), link) : null;
}

/**
 * The managed-tree inventory: the union of `.oms-tree/<alias>/<task>` directories on disk and the
 * `.oms-tree/` entries every locatable submodule gitdir reports, so manifest edits cannot orphan a
 * tree. A filesystem entry no porcelain run reports is a foreign directory; a prunable porcelain
 * entry (or a healthy one whose directory is gone) is broken and reports null branch/head/dirty.
 */
export function listManagedTrees(
  repoRoot: string,
  repos: Repo[],
  inspection: { dirtyAliases: "all" | readonly string[] },
  runner: RawGitRunner = productionGitRunner,
): ManagedTree[] {
  const root = join(repoRoot, TREE_DIRNAME);

  const fsUnits = new Map<string, { alias: string; task: string }>();
  const referenced: string[] = [];
  let aliasEntries: Dirent[];
  try {
    aliasEntries = readdirSync(root, { withFileTypes: true });
  } catch {
    aliasEntries = [];
  }
  for (const aliasEntry of aliasEntries) {
    if (!aliasEntry.isDirectory()) continue;
    let taskEntries;
    try {
      taskEntries = readdirSync(join(root, aliasEntry.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const taskEntry of taskEntries) {
      if (!taskEntry.isDirectory()) continue;
      fsUnits.set(`${aliasEntry.name}/${taskEntry.name}`, { alias: aliasEntry.name, task: taskEntry.name });
      const link = readGitdirLink(join(root, aliasEntry.name, taskEntry.name, ".git"));
      if (link) referenced.push(dirname(dirname(resolve(join(root, aliasEntry.name, taskEntry.name), link))));
    }
  }

  const declared = repos.map((repo) => submoduleGitDir(repoRoot, repo.alias)).filter((dir): dir is string => dir !== null);
  const probeOrder = [...new Set([...declared, ...[...new Set(referenced)].sort()])];

  const probed = new Map<string, { entry: PorcelainWorktreeEntry; gitdir: string }>();
  for (const gitdir of probeOrder) {
    const result = runGit(repoRoot, ["--git-dir", gitdir, "worktree", "list", "--porcelain"], false, undefined, runner);
    if (!result.success) continue;
    for (const entry of parseWorktreePorcelain(result.stdout)) {
      const key = managedTreePathKey(entry.path);
      if (!key) continue;
      const id = `${key.alias}/${key.task}`;
      if (!probed.has(id)) probed.set(id, { entry, gitdir });
    }
  }

  const trees: ManagedTree[] = [];
  for (const id of new Set([...fsUnits.keys(), ...probed.keys()])) {
    const unit = fsUnits.get(id) ?? managedTreePathKey(probed.get(id)!.entry.path)!;
    const { alias, task } = unit;
    const common = {
      alias,
      task,
      path: treeRelPath(alias, task),
      absolutePath: join(repoRoot, TREE_DIRNAME, alias, task),
    };
    const record = probed.get(id);
    if (record && !record.entry.prunable && fsUnits.has(id)) {
      trees.push({
        ...common,
        state: "healthy",
        branch: record.entry.branch,
        head: record.entry.head === null ? null : record.entry.head.slice(0, 7),
        dirty: null,
        error: null,
        gitdir: record.gitdir,
      });
    } else if (record) {
      const reason = record.entry.prunable
        ? `worktree link is broken: ${record.entry.prunable}`
        : "worktree directory is missing";
      trees.push({ ...common, state: "broken", branch: null, head: null, dirty: null, error: reason, gitdir: record.gitdir });
    } else {
      trees.push({
        ...common,
        state: "foreign",
        branch: null,
        head: null,
        dirty: null,
        error: "not a registered worktree of any submodule",
        gitdir: null,
      });
    }
  }

  trees.sort((left, right) => left.alias.localeCompare(right.alias) || left.task.localeCompare(right.task));
  const dirtyAliases = inspection.dirtyAliases === "all" ? null : new Set(inspection.dirtyAliases);
  for (const tree of trees) {
    if (tree.state !== "healthy" || (dirtyAliases !== null && !dirtyAliases.has(tree.alias))) continue;
    const status = runGit(tree.absolutePath, ["status", "--porcelain=v1"], false, undefined, runner);
    if (!status.success) {
      tree.error = "could not inspect worktree state";
      continue;
    }
    tree.dirty = status.stdout.trim().length > 0;
  }
  return trees;
}
