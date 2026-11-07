import { cancel, log } from "@clack/prompts";
import { existsSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { prepareAlias } from "./alias-preparation.js";
import { dim, pad } from "./env.js";
import { TREE_DIRNAME } from "./constants.js";
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
import { listManagedTrees, treeRelPath, type ManagedTree } from "./tree-inventory.js";
import { ensureTreeExcluded } from "./tree-exclude.js";



export function taskNameViolation(task: string): string | null {
  if (task.length === 0) return "the task name is empty";
  if (task.includes("/")) return 'task names must not contain "/" (one branch-name segment, e.g. "fix-auth")';
  if (task === "." || task === "..") return 'task names must not be "." or ".."';
  if (task.startsWith("-")) return 'task names must not start with "-"';
  return null;
}

export function checkTaskName(repoRoot: string, task: string, runner: RawGitRunner = productionGitRunner): string | null {
  const violation = taskNameViolation(task);
  if (violation) return violation;
  const result = runGit(repoRoot, ["check-ref-format", "--branch", task], false, undefined, runner);
  return result.success ? null : `"${task}" is not a valid branch name`;
}



async function resolveTreeAddArguments(
  repos: Repo[],
  aliasArg: string | undefined,
  taskArg: string | undefined,
): Promise<{ alias: string; task: string } | null> {
  // Manifest validation guarantees at least one configured repository.
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
  const duplicate = listManagedTrees(repoRoot, repos, { dirtyAliases: [] }).find((tree) => tree.alias === alias && tree.task === task);
  if (duplicate) {
    log.error(
      `A managed tree already exists at ${duplicate.path}. Remove it first with "oms tree remove ${alias} ${task}".`,
    );
    return 1;
  }

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


export async function runTreeList(): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  const trees = listManagedTrees(repoRoot, repos, { dirtyAliases: "all" });
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

  const trees = listManagedTrees(repoRoot, repos, { dirtyAliases: "all" });
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
