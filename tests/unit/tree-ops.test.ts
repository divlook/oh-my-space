import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import {
  appendLocalExcludeEntry,
  checkTaskName,
  insideManagedTree,
  listManagedTrees,
  managedTreePathKey,
  parseWorktreePorcelain,
  taskNameViolation,
  type PorcelainWorktreeEntry,
} from "../../scripts/lib/tree-ops.js";
import type { GitResult } from "../../scripts/lib/types.js";
import type { RawGitRunner } from "../../scripts/lib/git.js";
import type { Repo } from "../../scripts/lib/types.js";

function queuedRunner(results: GitResult[], calls: Array<{ cwd: string; args: string[] }> = []): RawGitRunner {
  return (cwd, args) => {
    calls.push({ cwd, args });
    const result = results.shift();
    assert.ok(result, `unexpected Git call: ${args.join(" ")}`);
    return result;
  };
}

const ok = (stdout = ""): GitResult => ({ exitCode: 0, success: true, stdout, stderr: "" });
const failed = (stderr = "failure"): GitResult => ({ exitCode: 1, success: false, stdout: "", stderr });

const repo = (alias: string): Repo => ({
  alias,
  remotes: { origin: `https://example.com/org/${alias}.git` },
  branch: "main",
});

test("tree-ops parses healthy, detached, and prunable porcelain shapes from the spike", () => {
  const porcelain = [
    "worktree /repo/.git/modules/oms/api",
    "HEAD b795c7074a85f0ff19231b8b43806017200c6ed4",
    "branch refs/heads/main",
    "",
    "worktree /repo/.oms-tree/api/fix-auth",
    "HEAD b795c7074a85f0ff19231b8b43806017200c6ed4",
    "branch refs/heads/fix-auth",
    "",
    "worktree /repo/.oms-tree/api/det-task",
    "HEAD b795c7074a85f0ff19231b8b43806017200c6ed4",
    "detached",
    "",
    "worktree /old-root/.oms-tree/api/gone",
    "HEAD b795c7074a85f0ff19231b8b43806017200c6ed4",
    "branch refs/heads/gone",
    "prunable gitdir file points to non-existent location",
    "",
  ].join("\n");

  const entries = parseWorktreePorcelain(porcelain);
  assert.deepEqual(entries, [
    {
      path: "/repo/.git/modules/oms/api",
      head: "b795c7074a85f0ff19231b8b43806017200c6ed4",
      branch: "main",
      prunable: null,
    },
    {
      path: "/repo/.oms-tree/api/fix-auth",
      head: "b795c7074a85f0ff19231b8b43806017200c6ed4",
      branch: "fix-auth",
      prunable: null,
    },
    {
      path: "/repo/.oms-tree/api/det-task",
      head: "b795c7074a85f0ff19231b8b43806017200c6ed4",
      branch: null,
      prunable: null,
    },
    {
      path: "/old-root/.oms-tree/api/gone",
      head: "b795c7074a85f0ff19231b8b43806017200c6ed4",
      branch: "gone",
      prunable: "gitdir file points to non-existent location",
    },
  ] satisfies PorcelainWorktreeEntry[]);
});

test("tree-ops extracts the alias/task key suffix-based, so moved roots still match", () => {
  assert.deepEqual(managedTreePathKey("/old-root/.oms-tree/api/fix-auth"), { alias: "api", task: "fix-auth" });
  assert.deepEqual(managedTreePathKey("/repo/.oms-tree/web/ui-fix"), { alias: "web", task: "ui-fix" });
  assert.equal(managedTreePathKey("/repo/.git/modules/oms/api"), null);
  assert.equal(managedTreePathKey("/repo/.oms-tree/api"), null);
  assert.equal(managedTreePathKey("/repo/.oms-tree/api/fix-auth/extra"), null);
});

test("tree-ops classifies the filesystem ∪ porcelain union with foreign directories and undeclared aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "oms-tree-unit-"));
  try {
    // Filesystem layout: api/fix-auth (a registered worktree, mocked porcelain), api/stray
    // (no porcelain entry → foreign), legacy/task (porcelain reports it, but the alias is no
    // longer declared → still listed through the tree-referenced gitdir probe).
    mkdirSync(join(root, ".oms-tree/api/fix-auth"), { recursive: true });
    mkdirSync(join(root, ".oms-tree/api/stray"), { recursive: true });
    mkdirSync(join(root, ".oms-tree/legacy/task"), { recursive: true });
    // The declared alias's gitdir must be locatable for its probe to run.
    mkdirSync(join(root, "oms/api"), { recursive: true });
    writeFileSync(join(root, "oms/api/.git"), "gitdir: /repo/.git/modules/oms/api\n");
    // The legacy tree's .git link references a gitdir the inventory must probe even though the
    // alias is undeclared.
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
    // Probe order: the declared alias's gitdir (api) first, then the tree-referenced gitdir
    // (legacy), then one status probe per healthy tree in sorted order (fix-auth, task).
    const runner = queuedRunner([ok(declaredPorcelain), ok(legacyPorcelain), ok(""), ok("")]);

    const trees = listManagedTrees(root, [repo("api")], runner);
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

    // An undeclared alias's tree stays listed — manifest edits cannot orphan it.
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
    // Second probe is the tree-referenced gitdir (the dirty tree's own link); it reports the
    // dirty tree healthy. The clean entry is prunable in the first report and stays prunable.
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
    // Dirty probes run per healthy tree in sorted order: dirty first, then... only "dirty" is
    // healthy (clean is prunable in every report), so one status probe. Untracked output ⇒ dirty.
    const runner = queuedRunner([ok(porcelain), ok(dirtyPorcelain), ok("?? untracked.txt\n")]);

    const trees = listManagedTrees(root, [repo("api")], runner);
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

test("tree-ops task-name validation enforces the no-separator rule before check-ref-format", () => {
  assert.equal(taskNameViolation("fix-auth"), null);
  assert.equal(taskNameViolation("feat/x"), 'task names must not contain "/" (one branch-name segment, e.g. "fix-auth")');
  assert.equal(taskNameViolation(""), "the task name is empty");
  assert.equal(taskNameViolation(".."), 'task names must not be "." or ".."');
  assert.equal(taskNameViolation("-bad"), 'task names must not start with "-"');

  // The structural rule rejects before any Git call runs.
  const structuralCalls: Array<{ cwd: string; args: string[] }> = [];
  assert.equal(
    checkTaskName("/repo", "feat/x", queuedRunner([failed("must not run")], structuralCalls)),
    'task names must not contain "/" (one branch-name segment, e.g. "fix-auth")',
  );
  assert.deepEqual(structuralCalls, []);

  assert.equal(checkTaskName("/repo", "a..b", queuedRunner([failed()])), '"a..b" is not a valid branch name');
  assert.equal(checkTaskName("/repo", "ok-name_v1.2", queuedRunner([ok()])), null);
});

test("tree-ops exclude-entry decision is idempotent across both spellings", () => {
  assert.equal(appendLocalExcludeEntry(""), "# managed by oms\n.oms-tree/\n");
  assert.equal(appendLocalExcludeEntry("# default\n"), "# default\n# managed by oms\n.oms-tree/\n");
  assert.equal(appendLocalExcludeEntry("# default\n.oms-tree/\n"), null);
  assert.equal(appendLocalExcludeEntry("# default\n/.oms-tree/\n"), null);
  assert.equal(appendLocalExcludeEntry("*.log\n\n\n"), "*.log\n# managed by oms\n.oms-tree/\n");
});

test("tree-ops guard resolves the namespace below the given root only", () => {
  assert.equal(insideManagedTree("/repo", "/repo/.oms-tree/api/fix-auth"), true);
  assert.equal(insideManagedTree("/repo", "/repo/.oms-tree"), true);
  assert.equal(insideManagedTree("/repo", "/repo/.oms-tree-other/x"), false);
  assert.equal(insideManagedTree("/repo", "/repo/oms/api"), false);
  assert.equal(insideManagedTree("/repo", "/elsewhere/.oms-tree/api/x"), false);
});
