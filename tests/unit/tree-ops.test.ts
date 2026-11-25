import assert from "node:assert/strict";
import test from "node:test";
import { taskNameViolation } from "../../scripts/lib/tree-ops.js";
import { insideManagedTree } from "../../scripts/lib/tree-context.js";

test("tree-ops task-name validation rejects invalid task segments", () => {
  assert.equal(taskNameViolation("fix-auth"), null);
  assert.equal(taskNameViolation("feat/x"), 'task names must not contain "/" (one branch-name segment, e.g. "fix-auth")');
  assert.equal(taskNameViolation(""), "the task name is empty");
  assert.equal(taskNameViolation(".."), 'task names must not be "." or ".."');
  assert.equal(taskNameViolation("-bad"), 'task names must not start with "-"');
});

test("tree-ops guard resolves the namespace below the given root only", () => {
  assert.equal(insideManagedTree("/repo", "/repo/.oms-tree/api/fix-auth"), true);
  assert.equal(insideManagedTree("/repo", "/repo/.oms-tree"), true);
  assert.equal(insideManagedTree("/repo", "/repo/.oms-tree-other/x"), false);
  assert.equal(insideManagedTree("/repo", "/repo/oms/api"), false);
  assert.equal(insideManagedTree("/repo", "/elsewhere/.oms-tree/api/x"), false);
});
