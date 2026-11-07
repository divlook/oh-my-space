import assert from "node:assert/strict";
import test from "node:test";
import { checkTaskName, taskNameViolation } from "../../scripts/lib/tree-ops.js";
import { managedTreePathKey, parseWorktreePorcelain, type PorcelainWorktreeEntry } from "../../scripts/lib/tree-inventory.js";
import { insideManagedTree } from "../../scripts/lib/tree-context.js";
import { appendLocalExcludeEntry } from "../../scripts/lib/tree-exclude.js";



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


test("tree-ops task-name validation enforces the no-separator rule before check-ref-format", () => {
  assert.equal(taskNameViolation("fix-auth"), null);
  assert.equal(taskNameViolation("feat/x"), 'task names must not contain "/" (one branch-name segment, e.g. "fix-auth")');
  assert.equal(taskNameViolation(""), "the task name is empty");
  assert.equal(taskNameViolation(".."), 'task names must not be "." or ".."');
  assert.equal(taskNameViolation("-bad"), 'task names must not start with "-"');

  let called = false;
  assert.equal(
    checkTaskName("/repo", "feat/x", () => { called = true; throw new Error("must not run"); }),
    'task names must not contain "/" (one branch-name segment, e.g. "fix-auth")',
  );
  assert.equal(called, false);
  assert.equal(checkTaskName("/repo", "a..b", () => ({ success: false, exitCode: 1, stdout: "", stderr: "invalid ref" })), '"a..b" is not a valid branch name');
  assert.equal(checkTaskName("/repo", "ok-name_v1.2", () => ({ success: true, exitCode: 0, stdout: "", stderr: "" })), null);
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
