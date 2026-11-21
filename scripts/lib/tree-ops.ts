import { cancel, log } from "@clack/prompts";
import { existsSync, lstatSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { dim, pad } from "./env.js";
import { TREE_DIRNAME } from "./constants.js";
import { localBranchExists, runGit } from "./git.js";
import { canPrompt, guardedSelect, guardedText, isCancel } from "./prompt-adapter.js";
import type { Repo } from "./types.js";
import { insideTreePath } from "./tree-context.js";
import { listIndependentManagedTrees, treeRelPath, type ManagedTree } from "./tree-inventory.js";
import { ensureTreeExcluded } from "./tree-exclude.js";
import { inspectSourceCheckout } from "./source-checkout.js";
import { loadForSources } from "./source-workspace.js";

export function taskNameViolation(task: string): string | null {
  if (task.length === 0) return "the task name is empty";
  if (task.includes("/")) return 'task names must not contain "/" (one branch-name segment, e.g. "fix-auth")';
  if (task === "." || task === "..") return 'task names must not be "." or ".."';
  if (task.startsWith("-")) return 'task names must not start with "-"';
  return null;
}

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
    const choice = await guardedSelect<string>({
      message: "Select a source repository for the task tree",
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


export async function runIndependentTreeAdd(
  aliasArg: string | undefined,
  taskArg: string | undefined,
  options: { from?: string },
): Promise<number> {
  const loaded = loadForSources();
  if (!loaded) return 1;
  const { repos, workspace, repoRoot } = loaded;
  const resolved = await resolveTreeAddArguments(repos, aliasArg, taskArg);
  if (!resolved) return 1;
  const { alias, task } = resolved;
  const repo = repos.find((candidate) => candidate.alias === alias);
  if (!repo) {
    log.error(`Unknown alias "${alias}". Use "oms clone --list" to see declared aliases.`);
    return 1;
  }
  const violation = taskNameViolation(task);
  const checked = violation ? null : workspace.git(repoRoot, ["check-ref-format", "--branch", task]);
  if (violation || !checked?.success || checked.stdout !== `${task}\n`) {
    log.error(`Invalid task name "${task}": ${violation ?? "use a literal, valid branch name"}. Nothing was created under ${TREE_DIRNAME}/.`);
    return 1;
  }

  try {
    const parent = join(repoRoot, TREE_DIRNAME, alias);
    const duplicate = listIndependentManagedTrees(workspace, { dirtyAliases: [] })
      .find((tree) => tree.alias === alias && tree.task === task);
    if (duplicate) {
      log.error(`A managed tree already exists at ${duplicate.path}. Remove it first with "oms tree remove ${alias} ${task}".`);
      return 1;
    }
    const parentInfo = lstatSync(parent, { throwIfNoEntry: false });
    if (parentInfo && !parentInfo.isDirectory()) throw new Error(`${parent} is not a canonical managed-tree directory`);
    const checkout = inspectSourceCheckout(workspace, repo);
    if (checkout.kind !== "ready") {
      log.error(`${alias}: ${checkout.reason} No task tree was created.`);
      return 1;
    }

    const exists = localBranchExists(checkout.path, task, workspace.git);
    if (exists && options.from !== undefined) {
      log.error(`${alias}: branch "${task}" already exists. Omit --from to resume it at its tip, or choose a new task name.`);
      return 1;
    }
    const absolute = join(parent, task);
    let args = ["worktree", "add", "--no-guess-remote", "--", absolute, task];
    if (!exists) {
      const start = options.from ?? "HEAD";
      const commit = workspace.git(checkout.path, ["rev-parse", "--verify", "--end-of-options", `${start}^{commit}`]);
      if (!commit.success) {
        log.error(`${alias}: "${start}" is not a readable local commit. No task tree was created.`);
        return 1;
      }
      args = ["worktree", "add", "--no-guess-remote", "-b", task, "--", absolute, commit.stdout.trim()];
    }
    ensureTreeExcluded(workspace);
    const result = runGit(checkout.path, args, true, undefined, workspace.git);
    if (!result.success) return 2;
    log.success(`${alias}: created task tree ${task} (${exists ? "resumed" : "new"} branch ${task}).`);
    return 0;
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runIndependentTreeList(): Promise<number> {
  const loaded = loadForSources();
  if (!loaded) return 1;
  try {
    return printTreeInventory(listIndependentManagedTrees(loaded.workspace, { dirtyAliases: "all" }));
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function printTreeInventory(trees: ManagedTree[]): number {
  if (trees.length === 0) {
    log.info(`No managed trees. Create one with "oms tree add <alias> <task>".`);
    return 0;
  }

  const rows = trees.map((tree) => ({
    alias: tree.alias,
    task: tree.task,
    branch: tree.state === "healthy" ? (tree.branch ?? "(detached)") : "-",
    dirty: tree.state !== "healthy" || tree.dirty === null ? "-" : tree.dirty ? "yes" : "no",
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
async function resolveTreeRemoveTarget<Tree extends ManagedTree>(
  trees: Tree[],
  aliasArg: string | undefined,
  taskArg: string | undefined,
): Promise<Tree | null> {
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
    // An already absent alias directory does not prevent cleaning the namespace root.
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


export async function runIndependentTreeRemove(
  aliasArg: string | undefined,
  taskArg: string | undefined,
  options: { force?: boolean },
): Promise<number> {
  const loaded = loadForSources();
  if (!loaded) return 1;
  const { workspace, repoRoot } = loaded;
  try {
    const explicit = aliasArg !== undefined && taskArg !== undefined;
    const initial = listIndependentManagedTrees(workspace, { dirtyAliases: explicit ? [aliasArg] : [] });
    const selected = await resolveTreeRemoveTarget(initial, aliasArg, taskArg);
    if (!selected) return 1;
    const { alias, task } = selected;
    const entry = explicit ? selected : listIndependentManagedTrees(workspace, { dirtyAliases: [alias] })
      .find((tree) => tree.path === selected.path);
    if (!entry) throw new Error(`No managed tree at ${selected.path}. Run "oms tree list" to see the trees that exist.`);

    const { absolutePath, path, registration } = entry;
    const parent = lstatSync(join(repoRoot, TREE_DIRNAME, alias), { throwIfNoEntry: false });
    if (parent && !parent.isDirectory()) throw new Error(`${path} is not under a canonical managed-tree directory. State preserved.`);
    if (insideTreePath(absolutePath)) {
      throw new Error(`The current directory is inside ${path}. Run "oms tree remove ${alias} ${task}" from outside the tree. The worktree and its branch were preserved.`);
    }

    if (entry.state === "foreign") {
      const info = lstatSync(absolutePath, { throwIfNoEntry: false });
      if (!info) throw new Error(`No managed tree at ${path}. Run "oms tree list" to see the trees that exist.`);
      if (!options.force && (!info.isDirectory() || readdirSync(absolutePath).length !== 0)) {
        throw new Error(`${path} is not a registered worktree and is not an empty directory. Its contents were preserved. Re-run with --force to delete it.`);
      }
      rmSync(absolutePath, { recursive: true });
      cleanupEmptyTreeParents(repoRoot, alias);
      log.success(`${alias}: removed ${task} (not a registered worktree).`);
      return 0;
    }

    if (entry.dirty === true && !options.force) {
      throw new Error(`${alias}: task tree ${task} has uncommitted changes. The worktree, its changes, and its branch were preserved. Commit or stash them first, or re-run with --force to discard the working tree.`);
    }
    if (entry.state === "broken") {
      if (entry.gitdir && !registration) throw new Error(`Could not verify stale metadata for ${path}: ${entry.error}. Nothing was removed.`);
      if (registration?.locked) throw new Error(`${path} is locked in Git. Unlock it before retrying; nothing was removed.`);
      const info = lstatSync(absolutePath, { throwIfNoEntry: false });
      if (entry.dirty === null && info && !options.force &&
          (!info.isDirectory() || readdirSync(absolutePath).some((name) => name !== ".git"))) {
        throw new Error(`Could not verify changes in broken tree ${path}. Its contents were preserved. Re-run with --force to discard them.`);
      }
      if (info) rmSync(absolutePath, { recursive: true });
      // Only the selected backlink was verified; a broad Git prune could discard other worktrees.
      if (registration) rmSync(registration.adminDir, { recursive: true });
      cleanupEmptyTreeParents(repoRoot, alias);
      printTreeRemoved(alias, task, " (broken link; stale metadata removed)");
      return 0;
    }

    if (!registration) throw new Error(`Could not verify worktree registration for ${path}; nothing was removed.`);
    const removed = runGit(
      registration.sourceDir,
      ["worktree", "remove", ...(options.force ? ["--force"] : []), "--", absolutePath],
      true, undefined, workspace.git,
    );
    if (!removed.success) return 2;
    cleanupEmptyTreeParents(repoRoot, alias);
    printTreeRemoved(alias, task, "");
    return 0;
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
