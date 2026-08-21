import { cancel, log } from "@clack/prompts";
import type { Dirent } from "node:fs";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { prepareAlias } from "./alias-preparation.js";
import { dim, pad } from "./env.js";
import { GITIGNORE_COMMENT, TREE_DIRNAME, TREE_EXCLUDE_ENTRY } from "./constants.js";
import {
  aliasDir,
  localBranchExists,
  productionGitRunner,
  runGit,
  runSub,
  submodulePath,
  type RawGitRunner,
} from "./git.js";
import { loadForSubmodules } from "./manifest.js";
import { canPrompt, guardedSelect, guardedText, isCancel } from "./prompt-adapter.js";
import type { Repo } from "./types.js";

/**
 * Managed trees: disposable per-task Git worktrees layered on initialized submodules at
 * `<root>/.oms-tree/<alias>/<task>/`. The lifecycle creates no root commits, no `.gitmodules`
 * entries, and no gitlinks; the namespace is kept out of root status through the root's local
 * exclude file.
 */

export type ManagedTreeState = "healthy" | "broken" | "foreign";

/** One inventory entry under `.oms-tree/`, whatever its health. */
export type ManagedTree = {
  alias: string;
  task: string;
  /** Repository-relative path, e.g. `.oms-tree/api/fix-auth`. */
  path: string;
  absolutePath: string;
  state: ManagedTreeState;
  /** Branch checked out in the tree, or null when detached or unreadable. */
  branch: string | null;
  /** Short HEAD SHA, or null when unreadable. */
  head: string | null;
  /** Staged, unstaged, and untracked changes present; null when unreadable. */
  dirty: boolean | null;
  error: string | null;
  /** Submodule gitdir whose porcelain reported this entry; null for foreign directories. */
  gitdir: string | null;
};

/** One parsed `git worktree list --porcelain` record. */
export type PorcelainWorktreeEntry = {
  path: string;
  head: string | null;
  /** Short branch name with the `refs/heads/` prefix stripped; null when detached. */
  branch: string | null;
  /** Prunable reason when Git considers the worktree removable metadata. */
  prunable: string | null;
};

/** Repository-relative tree path — the rule agents use to derive a tree's location. */
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

/** Read a gitdir link file (`gitdir: <path>`), returning the target or null when unusable. */
function readGitdirLink(path: string): string | null {
  try {
    const match = readFileSync(path, "utf8").trim().match(/^gitdir:\s*(\S.*)$/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/** Locate an initialized submodule's gitdir from its `.git` file or directory; null when absent. */
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
  runner: RawGitRunner = productionGitRunner,
): ManagedTree[] {
  const root = join(repoRoot, TREE_DIRNAME);

  // Filesystem units, plus the gitdirs their own `.git` links reference (undeclared aliases).
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

  // Probe declared aliases' gitdirs first (manifest order), then tree-referenced ones (sorted).
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

  // Union. A healthy entry needs both a healthy porcelain record and the directory on disk.
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
  // Dirty derivation runs last, in the sorted order above, so queued-runner tests stay deterministic.
  for (const tree of trees) {
    if (tree.state !== "healthy") continue;
    const status = runGit(tree.absolutePath, ["status", "--porcelain=v1"], false, undefined, runner);
    if (!status.success) {
      tree.error = "could not inspect worktree state";
      continue;
    }
    tree.dirty = status.stdout.trim().length > 0;
  }
  return trees;
}

// ─── Local exclude management ───

/**
 * Decide what the root's local exclude content should become so `.oms-tree/` is excluded. Returns
 * the new content, or null when an entry (either spelling) is already present. Pure decision: the
 * unit tests drive it directly.
 */
export function appendLocalExcludeEntry(content: string): string | null {
  const hasEntry = content
    .split("\n")
    .some((line) => line.trim() === TREE_EXCLUDE_ENTRY || line.trim() === `/${TREE_EXCLUDE_ENTRY}`);
  if (hasEntry) return null;
  const base = content.replace(/\n+$/, "");
  return `${base.length > 0 ? `${base}\n` : ""}${GITIGNORE_COMMENT}\n${TREE_EXCLUDE_ENTRY}\n`;
}

/** The root's local exclude file path, or null when it cannot be located. */
export function rootLocalExcludePath(repoRoot: string, runner: RawGitRunner = productionGitRunner): string | null {
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

/** Whether the root's local exclude file carries the `.oms-tree/` entry; null when unreadable. */
export function rootExcludeEntryPresent(repoRoot: string, runner: RawGitRunner = productionGitRunner): boolean | null {
  const path = rootLocalExcludePath(repoRoot, runner);
  if (path === null) return null;
  if (!existsSync(path)) return false;
  const next = appendLocalExcludeEntry(readFileSync(path, "utf8"));
  return next === null;
}

/** Keep `.oms-tree/` out of the root's untracked files, idempotently, without root commits. */
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

// ─── Task-name validation ───

/** Structural task-name rule: a single branch-name segment without separators. */
export function taskNameViolation(task: string): string | null {
  if (task.length === 0) return "the task name is empty";
  if (task.includes("/")) return 'task names must not contain "/" (one branch-name segment, e.g. "fix-auth")';
  if (task === "." || task === "..") return 'task names must not be "." or ".."';
  if (task.startsWith("-")) return 'task names must not start with "-"';
  return null;
}

/** Full task-name check: the structural rule plus `git check-ref-format --branch`. */
export function checkTaskName(repoRoot: string, task: string, runner: RawGitRunner = productionGitRunner): string | null {
  const violation = taskNameViolation(task);
  if (violation) return violation;
  const result = runGit(repoRoot, ["check-ref-format", "--branch", task], false, undefined, runner);
  return result.success ? null : `"${task}" is not a valid branch name`;
}

// ─── Tree-cwd guard ───

/** True when the given directory is inside the resolved root's `.oms-tree/` namespace. */
export function insideManagedTree(repoRoot: string, cwd: string = process.cwd()): boolean {
  const root = resolve(repoRoot, TREE_DIRNAME);
  const current = resolve(cwd);
  return current === root || current.startsWith(`${root}${sep}`);
}

/**
 * Shared pre-check for commands that operate on submodules: refuse before alias resolution,
 * preparation, or any Git mutation when the cwd is inside a managed tree. Returns true when the
 * caller should stop (the refusal was logged).
 */
export function refuseInsideManagedTree(repoRoot: string): boolean {
  if (!insideManagedTree(repoRoot)) return false;
  log.error(
    "This command ran from inside a managed tree (.oms-tree/). Use Git directly inside the tree; " +
      "run oms commands from the canonical checkout (oms/<alias>/) or the workspace root.",
  );
  return true;
}

// ─── oms tree add ───

/** Interactive fallbacks for omitted `tree add` arguments. */
async function resolveTreeAddArguments(
  repos: Repo[],
  aliasArg: string | undefined,
  taskArg: string | undefined,
): Promise<{ alias: string; task: string } | null> {
  let alias = aliasArg;
  let task = taskArg;
  if (alias === undefined && task === undefined && !canPrompt()) {
    log.error('Usage error: "oms tree add <alias> <task>" — an alias and a task are required when stdin is not interactive.');
    return null;
  }
  if (alias === undefined && !canPrompt()) {
    log.error('Usage error: "oms tree add <alias> <task>" — an alias is required when stdin is not interactive.');
    return null;
  }
  if (task === undefined && !canPrompt()) {
    log.error('Usage error: "oms tree add <alias> <task>" — a task is required when stdin is not interactive.');
    return null;
  }
  if (alias === undefined) {
    if (repos.length === 0) {
      log.error('No repos are declared in oms.yaml. Declare one, then run "oms tree add <alias> <task>".');
      return null;
    }
    const choice = await guardedSelect<string>({
      message: "Select a submodule for the task tree",
      options: repos.map((repo) => ({
        value: repo.alias,
        label: repo.alias,
        hint: repo.branch ? `branch: ${repo.branch}` : undefined,
      })),
    });
    if (isCancel(choice)) {
      cancel("Cancelled.");
      return null;
    }
    alias = choice as string;
  }
  if (task === undefined) {
    const answer = await guardedText({ message: "Task name (branch) for the new tree" });
    if (isCancel(answer)) {
      cancel("Cancelled.");
      return null;
    }
    task = (answer as string).trim();
  }
  return { alias, task };
}

export async function runTreeAdd(
  aliasArg: string | undefined,
  taskArg: string | undefined,
  options: { from?: string },
): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  const resolved = await resolveTreeAddArguments(repos, aliasArg, taskArg);
  if (!resolved) return 1;
  const { alias, task } = resolved;

  // The task is both the directory name and the branch name; validate before touching anything.
  const violation = checkTaskName(repoRoot, task);
  if (violation) {
    log.error(`Invalid task name "${task}": ${violation}. Nothing was created under ${TREE_DIRNAME}/.`);
    return 1;
  }

  const repo = repos.find((r) => r.alias === alias);
  if (!repo) {
    log.error(`Unknown alias "${alias}". Use "oms sync --list" to see registered aliases.`);
    return 1;
  }

  // Refuse a duplicate before preparation: the path is already an inventory entry, whatever it is.
  const duplicate = listManagedTrees(repoRoot, repos).find((tree) => tree.alias === alias && tree.task === task);
  if (duplicate) {
    log.error(
      `A managed tree already exists at ${duplicate.path}. Remove it first with "oms tree remove ${alias} ${task}".`,
    );
    return 1;
  }

  // Shared preparation (auto-initialize, interactive sync offer for unregistered aliases), but no
  // detached-HEAD resolution: the task branch starts at the current HEAD commit and the canonical
  // checkout is never moved.
  const prepared = await prepareAlias(repoRoot, repo, { command: "tree add", topologyOffer: true, requiresSettledTopology: false });
  if (!prepared.ok) return prepared.code;

  const dir = aliasDir(repoRoot, alias);
  const absolute = join(repoRoot, TREE_DIRNAME, alias, task);
  const exists = localBranchExists(dir, task);
  if (exists && options.from) {
    log.error(
      `${alias}: branch "${task}" already exists, so --from cannot set its start point. ` +
        `Omit --from to resume the branch at its tip, or choose a new task name.`,
    );
    return 1;
  }

  const args = exists
    ? ["worktree", "add", absolute, task]
    : ["worktree", "add", "-b", task, absolute, ...(options.from ? [options.from] : [])];
  log.step(`${alias}: git -C ${submodulePath(alias)} ${args.join(" ")}`);
  const result = runSub(repoRoot, alias, args, true);
  if (!result.success) return 2;

  ensureTreeExcluded(repoRoot);
  log.success(`${alias}: created task tree ${task} (${exists ? "resumed" : "new"} branch ${task}).`);
  return 0;
}

// ─── oms tree list ───

export async function runTreeList(): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  const trees = listManagedTrees(repoRoot, repos);
  if (trees.length === 0) {
    log.info(`No managed trees. Create one with "oms tree add <alias> <task>".`);
    return 0;
  }

  const rows = trees.map((tree) => ({
    alias: tree.alias,
    task: tree.task,
    branch: tree.state === "healthy" ? (tree.branch ?? "(detached)") : "-",
    dirty: tree.state === "healthy" ? (tree.dirty ? "yes" : "no") : "-",
    state: tree.state === "healthy" ? "ok" : tree.state === "broken" ? "broken" : "not a registered worktree",
  }));
  const col = (key: keyof (typeof rows)[number], header: string) =>
    Math.max(header.length, ...rows.map((row) => row[key].length));
  const aW = col("alias", "ALIAS");
  const tW = col("task", "TASK");
  const bW = col("branch", "BRANCH");
  const dW = col("dirty", "DIRTY");
  console.log(
    dim(`${pad("ALIAS", aW)}  ${pad("TASK", tW)}  ${pad("BRANCH", bW)}  ${pad("DIRTY", dW)}  STATE`),
  );
  for (const row of rows) {
    console.log(`${pad(row.alias, aW)}  ${pad(row.task, tW)}  ${pad(row.branch, bW)}  ${pad(row.dirty, dW)}  ${row.state}`);
  }
  return 0;
}

// ─── oms tree remove ───

/** Interactive alias-then-task selection over the inventory, never auto-selecting a sole candidate. */
async function resolveTreeRemoveTarget(
  trees: ManagedTree[],
  aliasArg: string | undefined,
  taskArg: string | undefined,
): Promise<ManagedTree | null> {
  const find = (alias: string, task: string) => trees.find((tree) => tree.alias === alias && tree.task === task);
  if (aliasArg !== undefined && taskArg !== undefined) {
    const entry = find(aliasArg, taskArg);
    if (!entry) {
      log.error(
        `No managed tree at ${treeRelPath(aliasArg, taskArg)}. Run "oms tree list" to see the trees that exist.`,
      );
      return null;
    }
    return entry;
  }

  if (!canPrompt()) {
    log.error(
      `Usage error: "oms tree remove <alias> <task>" — ${
        aliasArg === undefined && taskArg === undefined ? "an alias and a task" : aliasArg === undefined ? "an alias" : "a task"
      } ${aliasArg === undefined && taskArg === undefined ? "are" : "is"} required when stdin is not interactive.`,
    );
    return null;
  }
  if (trees.length === 0) {
    log.error('No managed trees to remove. Run "oms tree list" to see the trees that exist.');
    return null;
  }

  let alias = aliasArg;
  if (alias === undefined) {
    const aliases = [...new Set(trees.map((tree) => tree.alias))];
    const choice = await guardedSelect<string>({
      message: "Select the alias of the tree to remove",
      options: aliases.map((name) => ({ value: name, label: name })),
    });
    if (isCancel(choice)) {
      cancel("Cancelled.");
      return null;
    }
    alias = choice as string;
  }

  let task = taskArg;
  if (task === undefined) {
    const tasks = trees.filter((tree) => tree.alias === alias).map((tree) => tree.task);
    if (tasks.length === 0) {
      log.error(`No managed trees for alias "${alias}". Run "oms tree list" to see the trees that exist.`);
      return null;
    }
    const choice = await guardedSelect<string>({
      message: `Select the task tree of ${alias} to remove`,
      options: tasks.map((name) => ({ value: name, label: name })),
    });
    if (isCancel(choice)) {
      cancel("Cancelled.");
      return null;
    }
    task = choice as string;
  }

  const entry = find(alias, task);
  if (!entry) {
    log.error(`No managed tree at ${treeRelPath(alias, task)}. Run "oms tree list" to see the trees that exist.`);
    return null;
  }
  return entry;
}

/** Delete the empty `.oms-tree/<alias>/` parent and, when the namespace empties, `.oms-tree/` itself. */
function cleanupEmptyTreeParents(repoRoot: string, alias: string): void {
  try {
    rmdirSync(join(repoRoot, TREE_DIRNAME, alias));
  } catch {
    return;
  }
  try {
    rmdirSync(join(repoRoot, TREE_DIRNAME));
  } catch {
    // Non-empty or absent: other aliases' trees (or stray files) still live there.
  }
}

/** Guidance after a worktree removal: resuming is cheap, branch deletion is a separate decision. */
function printTreeRemoved(alias: string, task: string, detail: string): void {
  log.success(`${alias}: removed task tree ${task}${detail}.`);
  log.info(`Resume it with "oms tree add ${alias} ${task}", or delete the branch with "oms branch delete ${alias} ${task}".`);
}

export async function runTreeRemove(
  aliasArg: string | undefined,
  taskArg: string | undefined,
  options: { force?: boolean },
): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  const trees = listManagedTrees(repoRoot, repos);
  const entry = await resolveTreeRemoveTarget(trees, aliasArg, taskArg);
  if (!entry) return 1;

  // The caller's shell must not sit inside the directory being deleted.
  const currentDir = resolve(process.cwd());
  const targetDir = resolve(entry.absolutePath);
  if (currentDir === targetDir || currentDir.startsWith(`${targetDir}${sep}`)) {
    log.error(
      `The current directory is inside ${entry.path}. Run "oms tree remove ${entry.alias} ${entry.task}" from outside the tree. ` +
        "The worktree and its branch were preserved.",
    );
    return 1;
  }

  if (entry.state === "foreign") {
    if (!existsSync(entry.absolutePath)) {
      log.error(`No managed tree at ${entry.path}. Run "oms tree list" to see the trees that exist.`);
      return 1;
    }
    const empty = readdirSync(entry.absolutePath).length === 0;
    if (!empty && !options.force) {
      log.error(
        `${entry.path} is not a registered worktree and contains files. The directory and its files were preserved. ` +
          `Re-run with --force to delete it.`,
      );
      return 1;
    }
    rmSync(entry.absolutePath, { recursive: true, force: true });
    cleanupEmptyTreeParents(repoRoot, entry.alias);
    log.success(`${entry.alias}: removed ${entry.task} (not a registered worktree).`);
    return 0;
  }

  if (entry.state === "broken") {
    // Prunable metadata cannot be removed with `git worktree remove`; prune after clearing the dir.
    if (existsSync(entry.absolutePath)) rmSync(entry.absolutePath, { recursive: true, force: true });
    const pruned = runGit(repoRoot, ["--git-dir", entry.gitdir!, "worktree", "prune"], true, undefined);
    if (!pruned.success) return 2;
    cleanupEmptyTreeParents(repoRoot, entry.alias);
    printTreeRemoved(entry.alias, entry.task, " (broken link; administrative metadata pruned)");
    return 0;
  }

  if (entry.dirty === true && !options.force) {
    log.error(
      `${entry.alias}: task tree ${entry.task} has uncommitted changes. The worktree, its changes, and branch ${entry.task} were preserved. ` +
        "Commit or stash them first, or re-run with --force to discard the working tree.",
    );
    return 1;
  }
  const removed = runGit(
    repoRoot,
    ["--git-dir", entry.gitdir!, "worktree", "remove", ...(options.force ? ["--force"] : []), entry.absolutePath],
    true,
  );
  if (!removed.success) return 2;
  cleanupEmptyTreeParents(repoRoot, entry.alias);
  printTreeRemoved(entry.alias, entry.task, "");
  return 0;
}
