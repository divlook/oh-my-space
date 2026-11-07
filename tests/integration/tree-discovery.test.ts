import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listManagedTrees } from "../../scripts/lib/tree-inventory.js";
import type { GitResult, Repo } from "../../scripts/lib/types.js";
import type { RawGitRunner } from "../../scripts/lib/git.js";
const ok = (stdout = ""): GitResult => ({ exitCode: 0, success: true, stdout, stderr: "" });

const repo = (alias: string): Repo => ({
  alias,
  remotes: { origin: `https://example.com/org/${alias}.git` },
  branch: "main",
});

test("tree-ops classifies the filesystem ∪ porcelain union with foreign directories and undeclared aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "oms-tree-unit-"));
  try {
    mkdirSync(join(root, ".oms-tree/api/fix-auth"), { recursive: true });
    mkdirSync(join(root, ".oms-tree/api/stray"), { recursive: true });
    mkdirSync(join(root, ".oms-tree/legacy/task"), { recursive: true });
    mkdirSync(join(root, "oms/api"), { recursive: true });
    writeFileSync(join(root, "oms/api/.git"), "gitdir: /repo/.git/modules/oms/api\n");
    writeFileSync(join(root, ".oms-tree/legacy/task/.git"), "gitdir: /repo/.git/modules/oms/legacy/worktrees/task\n");

    const declaredPorcelain = [
      "worktree /repo/.git/modules/oms/api",
      "HEAD b795c7074a85f0ff19231b8b43806017200c6ed4",
      "branch refs/heads/main",
      "",
      "worktree /repo/.oms-tree/api/fix-auth",
      "HEAD b795c7074a85f0ff19231b8b43806017200c6ed4",
      "branch refs/heads/fix-auth",
      "",
    ].join("\n");
    const legacyPorcelain = [
      "worktree /repo/.git/modules/oms/legacy",
      "HEAD b795c7074a85f0ff19231b8b43806017200c6ed4",
      "branch refs/heads/main",
      "",
      "worktree /repo/.oms-tree/legacy/task",
      "HEAD b795c7074a85f0ff19231b8b43806017200c6ed4",
      "branch refs/heads/task",
      "",
    ].join("\n");
    const runner: RawGitRunner = (_cwd, args) => {
      if (args[0] === "--git-dir") return ok(args[1].includes("legacy") ? legacyPorcelain : declaredPorcelain);
      assert.equal(args[0], "status");
      return ok();
    };

    const trees = listManagedTrees(root, [repo("api")], { dirtyAliases: "all" }, runner);
    const byPath = new Map(trees.map((tree) => [tree.path, tree]));

    const fixAuth = byPath.get(".oms-tree/api/fix-auth");
    assert.ok(fixAuth);
    assert.equal(fixAuth.state, "healthy");
    assert.equal(fixAuth.branch, "fix-auth");
    assert.equal(fixAuth.head, "b795c70");
    assert.equal(fixAuth.dirty, false);

    const stray = byPath.get(".oms-tree/api/stray");
    assert.ok(stray);
    assert.equal(stray.state, "foreign");
    assert.equal(stray.error, "not a registered worktree of any submodule");

    const legacy = byPath.get(".oms-tree/legacy/task");
    assert.ok(legacy);
    assert.equal(legacy.state, "healthy");
    assert.equal(legacy.branch, "task");

    assert.equal(trees.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tree-ops dirty derivation is untracked-inclusive and broken entries keep null fields", () => {
  const root = mkdtempSync(join(tmpdir(), "oms-tree-unit-"));
  try {
    mkdirSync(join(root, ".oms-tree/api/clean"), { recursive: true });
    mkdirSync(join(root, ".oms-tree/api/dirty"), { recursive: true });
    writeFileSync(join(root, ".oms-tree/api/dirty/.git"), "gitdir: /repo/.git/modules/oms/api/worktrees/dirty\n");
    mkdirSync(join(root, "oms/api"), { recursive: true });
    writeFileSync(join(root, "oms/api/.git"), "gitdir: /repo/.git/modules/oms/api\n");

    const porcelain = [
      "worktree /repo/.git/modules/oms/api",
      "HEAD b795c7074a85f0ff19231b8b43806017200c6ed4",
      "branch refs/heads/main",
      "",
      "worktree /repo/.oms-tree/api/clean",
      "HEAD b795c7074a85f0ff19231b8b43806017200c6ed4",
      "branch refs/heads/clean",
      "prunable gitdir file points to non-existent location",
      "",
      "worktree /repo/.oms-tree/api/dirty",
      "HEAD b795c7074a85f0ff19231b8b43806017200c6ed4",
      "branch refs/heads/dirty",
      "",
    ].join("\n");
    const dirtyPorcelain = [
      "worktree /repo/.git/modules/oms/api/worktrees/dirty",
      "HEAD b795c7074a85f0ff19231b8b43806017200c6ed4",
      "branch refs/heads/dirty",
      "",
      "worktree /repo/.oms-tree/api/dirty",
      "HEAD b795c7074a85f0ff19231b8b43806017200c6ed4",
      "branch refs/heads/dirty",
      "",
    ].join("\n");
    const runner: RawGitRunner = (_cwd, args) => {
      if (args[0] === "--git-dir") return ok(args[1].includes("worktrees/dirty") ? dirtyPorcelain : porcelain);
      assert.equal(args[0], "status");
      return ok("?? untracked.txt\n");
    };

    const trees = listManagedTrees(root, [repo("api")], { dirtyAliases: "all" }, runner);
    const byTask = new Map(trees.map((tree) => [tree.task, tree]));

    const clean = byTask.get("clean");
    assert.ok(clean);
    assert.equal(clean.state, "broken");
    assert.equal(clean.error, "worktree link is broken: gitdir file points to non-existent location");
    assert.equal(clean.branch, null);
    assert.equal(clean.head, null);
    assert.equal(clean.dirty, null);

    const dirty = byTask.get("dirty");
    assert.ok(dirty);
    assert.equal(dirty.state, "healthy");
    assert.equal(dirty.dirty, true, "an untracked file must count as dirty");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
