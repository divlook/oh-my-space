import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { openSourceWorkspace } from "../../scripts/lib/source-checkout.js";
import { listIndependentManagedTrees } from "../../scripts/lib/tree-inventory.js";
import { git, gitOut, testEnv, workspaceWithApi } from "../helpers.js";

Object.assign(process.env, testEnv);

test("tree-ops classifies the filesystem ∪ porcelain union with foreign directories and undeclared aliases", () => {
  const { cwd, bare, wt } = workspaceWithApi();
  git(cwd, "clone", "--branch", "main", `file://${bare}`, "oms/former");
  git(wt, "worktree", "add", "-b", "fix-auth", join(cwd, ".oms-tree/api/fix-auth"));
  const detachedTask = "detached with\nspace";
  const detached = join(cwd, ".oms-tree", "api", detachedTask);
  git(wt, "worktree", "add", "--detach", detached, "HEAD");
  git(join(cwd, "oms/former"), "worktree", "add", "-b", "task", join(cwd, ".oms-tree/former/task"));
  mkdirSync(join(cwd, ".oms-tree/api/stray"));

  const trees = listIndependentManagedTrees(openSourceWorkspace(cwd), { dirtyAliases: "all" });
  assert.deepEqual(trees.map((tree) => [tree.path, tree.state, tree.branch, tree.dirty]), [
    [`.oms-tree/api/${detachedTask}`, "healthy", null, false],
    [".oms-tree/api/fix-auth", "healthy", "fix-auth", false],
    [".oms-tree/api/stray", "foreign", null, null],
    [".oms-tree/former/task", "healthy", "task", false],
  ]);
  assert.equal(trees[1]?.head, gitOut(wt, "rev-parse", "--short=7", "HEAD"));
  assert.equal(trees[2]?.error, "not a registered worktree of any source repository");
});

test("tree-ops dirty derivation is untracked-inclusive and broken entries keep null fields", () => {
  const { cwd, wt } = workspaceWithApi();
  const missing = join(cwd, ".oms-tree/api/clean");
  const dirtyPath = join(cwd, ".oms-tree/api/dirty");
  git(wt, "worktree", "add", "-b", "clean", missing);
  git(wt, "worktree", "add", "-b", "dirty", dirtyPath);
  rmSync(missing, { recursive: true });
  writeFileSync(join(dirtyPath, "untracked.txt"), "keep");

  const workspace = openSourceWorkspace(cwd);
  const [broken, dirty] = listIndependentManagedTrees(workspace, { dirtyAliases: "all" });
  assert.ok(broken);
  assert.equal(broken.task, "clean");
  assert.equal(broken.state, "broken");
  assert.match(broken.error ?? "", /gitdir file points to non-existent location|worktree link is broken/);
  assert.equal(broken.branch, null);
  assert.equal(broken.head, null);
  assert.equal(broken.dirty, null);
  assert.equal(dirty?.task, "dirty");
  assert.equal(dirty?.state, "healthy");
  assert.equal(dirty?.dirty, true, "an untracked file must count as dirty");
  assert.deepEqual(listIndependentManagedTrees(workspace, { dirtyAliases: [] }).map(({ dirty }) => dirty), [null, null]);
});
