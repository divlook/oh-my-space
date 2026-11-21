import type { Dirent } from "node:fs";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { ALIAS_PATTERN, DATA_DIRNAME, TREE_DIRNAME } from "./constants.js";
import type { SourceWorkspace } from "./source-checkout.js";

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
  /** Repository Git directory backing the worktree, when known. */
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
 * Extract the `<alias>/<task>` key from a porcelain path. Matching is suffix-based, so a prunable
 * entry recorded at a pre-relocation path still matches the tree's current on-disk location.
 */
export function managedTreePathKey(absolutePath: string): { alias: string; task: string } | null {
  const match = absolutePath.match(/(?:^|\/)\.oms-tree\/([^/]+)\/([^/]+)$/);
  return match ? { alias: match[1], task: match[2] } : null;
}


type IndependentRegistration = {
  adminDir: string;
  sourceDir: string;
  locked: boolean;
};

type IndependentManagedTree = ManagedTree & { registration: IndependentRegistration | null };

function entryInfo(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function subdirectories(path: string): Dirent[] {
  return entryInfo(path)?.isDirectory() ? readdirSync(path, { withFileTypes: true }) : [];
}

function readPathFile(path: string): string | null {
  if (!entryInfo(path)?.isFile()) return null;
  const content = readFileSync(path, "utf8");
  return content.endsWith("\n") ? content.slice(0, -1) : content;
}

function worktreeLink(path: string): string | null {
  const line = readPathFile(join(path, ".git"));
  return line?.startsWith("gitdir: ") ? resolve(path, line.slice(8)) : null;
}

function sourceAdminId(gitDir: string, adminDir: string): string | null {
  return dirname(adminDir) === join(gitDir, "worktrees") ? basename(adminDir) : null;
}

type IndependentWorktreeRecord = PorcelainWorktreeEntry & { locked: boolean };

function independentWorktreeRecords(output: string): IndependentWorktreeRecord[] {
  const records: IndependentWorktreeRecord[] = [];
  let current: IndependentWorktreeRecord | undefined;
  for (const field of output.split("\0")) {
    if (field.startsWith("worktree ")) {
      current = { path: field.slice(9), head: null, branch: null, prunable: null, locked: false };
      records.push(current);
    } else if (current) {
      if (field.startsWith("HEAD ")) current.head = field.slice(5);
      else if (field.startsWith("branch ")) current.branch = field.slice(7).replace(/^refs\/heads\//, "");
      else if (field === "prunable" || field.startsWith("prunable ")) current.prunable = field.slice(9) || "prunable";
      else if (field === "locked" || field.startsWith("locked ")) current.locked = true;
    }
  }
  return records;
}

/** Combines the reserved namespace with registrations owned by independent sources, including former sources. */
export function listIndependentManagedTrees(
  workspace: SourceWorkspace,
  inspection: { dirtyAliases: "all" | readonly string[] },
): IndependentManagedTree[] {
  const { root, git } = workspace;
  const namespace = join(root, TREE_DIRNAME);
  const namespaceInfo = entryInfo(namespace);
  if (namespaceInfo && !namespaceInfo.isDirectory()) throw new Error(`${namespace} is not a canonical managed-tree directory`);
  const trees = new Map<string, IndependentManagedTree>();
  const links = new Map<string, string>();
  const unavailableAliases = new Set<string>();

  function makeTree(alias: string, task: string): IndependentManagedTree {
    const path = treeRelPath(alias, task);
    return {
      alias, task, path, absolutePath: join(root, path), state: "foreign",
      branch: null, head: null, dirty: null, gitdir: null, registration: null,
      error: "not a registered worktree of any source repository",
    };
  }

  for (const alias of namespaceInfo ? readdirSync(namespace, { withFileTypes: true }) : []) {
    if (!alias.isDirectory()) {
      unavailableAliases.add(alias.name);
      continue;
    }
    for (const task of readdirSync(join(namespace, alias.name), { withFileTypes: true })) {
      const tree = makeTree(alias.name, task.name);
      trees.set(tree.path, tree);
      if (!task.isDirectory()) continue;
      const link = worktreeLink(tree.absolutePath);
      if (link) links.set(tree.path, link);
    }
  }

  const sources = join(root, DATA_DIRNAME);
  const dirtyAliases = inspection.dirtyAliases === "all" ? null : new Set(inspection.dirtyAliases);
  for (const alias of subdirectories(sources)) {
    if (!alias.isDirectory() || !ALIAS_PATTERN.test(alias.name)) continue;
    const source = join(sources, alias.name);
    const gitdir = join(source, ".git");
    if (!entryInfo(gitdir)?.isDirectory()) continue;
    const listed = git(source, ["worktree", "list", "--porcelain", "-z"]);
    if (!listed.success || listed.stderr) continue;
    const records = independentWorktreeRecords(listed.stdout);
    if (records[0]?.path !== source || records.length < 2) continue;
    const admins = new Map<string, string | null>();
    for (const admin of subdirectories(join(gitdir, "worktrees"))) {
      if (!admin.isDirectory()) continue;
      const adminDir = join(gitdir, "worktrees", admin.name);
      const backlink = readPathFile(join(adminDir, "gitdir"));
      const common = readPathFile(join(adminDir, "commondir"));
      if (backlink && common && resolve(adminDir, common) === gitdir) {
        const path = resolve(adminDir, backlink);
        admins.set(path, admins.has(path) ? null : adminDir);
      }
    }

    for (let index = 1; index < records.length; index++) {
      const record = records[index];
      const key = isAbsolute(record.path) && managedTreePathKey(record.path);
      if (!key || key.alias === "." || key.alias === ".." || key.task === "." || key.task === "..") continue;
      const { alias: treeAlias, task } = key;
      const path = treeRelPath(treeAlias, task);
      const absolutePath = join(root, path);
      const adminDir = admins.get(join(record.path, ".git"));
      const link = links.get(path);
      const direct = record.path === absolutePath;
      // A suffix alone is not ownership: an external worktree may use the same directory names.
      // A moved workspace has two stale links pointing back into the same former checkout.
      if (!direct) {
        if (!link || !adminDir || entryInfo(record.path)) continue;
        const previousRoot = dirname(dirname(dirname(record.path)));
        const formerGitDir = join(previousRoot, DATA_DIRNAME, alias.name, ".git");
        const oldAdminId = sourceAdminId(formerGitDir, link);
        if (link !== adminDir && (!oldAdminId || oldAdminId !== sourceAdminId(gitdir, adminDir))) continue;
      }
      const tree = trees.get(path) ?? makeTree(treeAlias, task);
      trees.set(path, tree);
      if (tree.gitdir) {
        tree.state = "broken";
        tree.branch = tree.head = tree.dirty = tree.registration = null;
        tree.error = "multiple worktree registrations claim this path";
        continue;
      }
      tree.gitdir = gitdir;
      tree.registration = adminDir ? { adminDir, sourceDir: source, locked: record.locked } : null;
      const hasDirectory = !unavailableAliases.has(treeAlias) && entryInfo(absolutePath)?.isDirectory();
      if (!direct || !adminDir || link !== adminDir || record.prunable || !hasDirectory) {
        tree.state = "broken";
        tree.error = record.prunable ?? "worktree link is broken or directory is missing";
      } else {
        tree.state = "healthy";
        tree.branch = record.branch;
        tree.head = record.head?.slice(0, 7) ?? null;
        tree.error = null;
      }
      if (!adminDir || !hasDirectory || (dirtyAliases && !dirtyAliases.has(treeAlias))) continue;
      const status = git(root, [
        "--no-optional-locks", "--git-dir", adminDir, "--work-tree", absolutePath,
        "status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=none",
      ]);
      if (status.success && !status.stderr) tree.dirty = status.stdout.length > 0;
      else if (tree.state === "healthy") tree.error = "could not inspect worktree state";
    }
  }

  for (const tree of trees.values()) {
    if (tree.state !== "foreign") continue;
    const link = links.get(tree.path);
    if (!link) continue;
    const gitdir = dirname(dirname(link));
    const source = dirname(gitdir);
    const alias = basename(source);
    if (dirname(source) !== sources || !ALIAS_PATTERN.test(alias) ||
        gitdir !== join(source, ".git") || !sourceAdminId(gitdir, link)) continue;
    if (entryInfo(gitdir)) {
      tree.gitdir = gitdir;
      tree.state = "broken";
      tree.error = "could not verify worktree registration";
    } else if (alias === tree.alias) {
      // A leftover Git file can identify a broken tree even after its source Git data is gone.
      tree.state = "broken";
      tree.error = "source Git directory is missing";
    }
  }
  return [...trees.values()].sort((left, right) => left.alias.localeCompare(right.alias) || left.task.localeCompare(right.task));
}
