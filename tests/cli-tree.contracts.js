import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "./sharded-test.js";
import {
  configIdentity,
  git,
  gitOut,
  queueEnv,
  run,
  workspaceWithApi,
} from "./helpers.js";

// ─── tree lifecycle journeys: one workspace fixture per journey ───

/** A healthy workspace with `api` synced, plus one managed tree on task `t1`. */
function workspaceWithTree(task = "t1") {
  const { cwd, bare, wt } = workspaceWithApi();
  run(["tree", "add", "api", task], { cwd });
  assert.equal(existsSync(join(cwd, ".oms-tree", "api", task)), true);
  return { cwd, bare, wt, tree: join(cwd, ".oms-tree", "api", task), task };
}

function rootSnapshot(cwd) {
  return {
    head: gitOut(cwd, "rev-parse", "HEAD"),
    gitmodules: existsSync(join(cwd, ".gitmodules"))
      ? readFileSync(join(cwd, ".gitmodules"), "utf8")
      : null,
  };
}

function assertRootSnapshot(cwd, before) {
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), before.head);
  if (before.gitmodules !== null) {
    assert.equal(readFileSync(join(cwd, ".gitmodules"), "utf8"), before.gitmodules);
  }
}

function treeBranches(cwd) {
  return gitOut(join(cwd, "oms", "api"), "for-each-ref", "--format=%(refname:short)", "refs/heads")
    .split("\n")
    .filter((name) => name.length > 0);
}

test("tree add starts at the canonical HEAD, prints one line, and leaves a detached canonical checkout detached", () => {
  const { cwd } = workspaceWithTree();
  const before = rootSnapshot(cwd);

  const result = run(["tree", "add", "api", "second"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /api: created task tree second \(new branch second\)/);
  const second = join(cwd, ".oms-tree", "api", "second");
  assert.equal(existsSync(second), true);
  assert.equal(
    gitOut(join(cwd, "oms", "api"), "rev-parse", "HEAD"),
    gitOut(second, "rev-parse", "HEAD"),
    "the task branch starts at the canonical HEAD commit",
  );
  assert.equal(gitOut(second, "rev-parse", "--abbrev-ref", "HEAD"), "second");
  assertRootSnapshot(cwd, before);

  // A detached canonical HEAD stays detached: no prompt, no branch switch, no checkout move.
  const wt = join(cwd, "oms", "api");
  git(wt, "checkout", "--detach", "HEAD");
  const headBefore = gitOut(wt, "rev-parse", "HEAD");
  const detached = run(["tree", "add", "api", "det-task"], { cwd });
  assert.equal(detached.status, 0, detached.stdout + detached.stderr);
  const detTree = join(cwd, ".oms-tree", "api", "det-task");
  assert.equal(gitOut(wt, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD", "canonical stays detached");
  assert.equal(gitOut(wt, "rev-parse", "HEAD"), headBefore, "canonical HEAD is untouched");
  assert.equal(gitOut(detTree, "rev-parse", "--abbrev-ref", "HEAD"), "det-task");
  assert.equal(gitOut(detTree, "rev-parse", "HEAD"), headBefore, "the task branch starts at the HEAD commit");
});

test("tree add --from sets the start point, resumes an existing branch, and refuses --from on resume", () => {
  const { cwd, bare } = workspaceWithTree();
  const wt = join(cwd, "oms", "api");

  // --from creates the branch at the named start point.
  const feature = gitOut(wt, "rev-parse", "HEAD");
  const fromResult = run(["tree", "add", "api", "from-task", "--from", "origin/main"], { cwd });
  assert.equal(fromResult.status, 0, fromResult.stdout + fromResult.stderr);
  assert.equal(gitOut(join(cwd, ".oms-tree", "api", "from-task"), "rev-parse", "HEAD"), feature);

  // Removing the tree keeps the branch, so a later re-add resumes it at its tip.
  const remove = run(["tree", "remove", "api", "t1"], { cwd });
  assert.equal(remove.status, 0, remove.stdout + remove.stderr);
  assert.equal(treeBranches(cwd).includes("t1"), true, "the branch survives removal");

  // --from with an existing branch fails before creating any worktree (no tree exists now).
  const conflict = run(["tree", "add", "api", "t1", "--from", "origin/main"], { cwd });
  const conflictOutput = conflict.stdout + conflict.stderr;
  assert.equal(conflict.status, 1, conflictOutput);
  assert.match(conflictOutput, /branch "t1" already exists, so --from cannot set its start point/);
  assert.equal(existsSync(join(cwd, ".oms-tree", "api", "t1")), false, "no worktree was created");

  const resume = run(["tree", "add", "api", "t1"], { cwd });
  const resumeOutput = resume.stdout + resume.stderr;
  assert.equal(resume.status, 0, resumeOutput);
  assert.match(resumeOutput, /resumed branch t1/);
  assert.equal(existsSync(bare), true);
});

test("tree add refuses duplicate paths including foreign directories, invalid names, and unknown aliases", () => {
  const { cwd } = workspaceWithTree();

  const duplicate = run(["tree", "add", "api", "t1"], { cwd });
  const duplicateOutput = duplicate.stdout + duplicate.stderr;
  assert.equal(duplicate.status, 1, duplicateOutput);
  assert.match(duplicateOutput, /A managed tree already exists at \.oms-tree\/api\/t1/);
  assert.match(duplicateOutput, /oms tree remove api t1/);

  // A foreign directory occupies the path too.
  mkdirSync(join(cwd, ".oms-tree", "api", "stray"), { recursive: true });
  const foreignDuplicate = run(["tree", "add", "api", "stray"], { cwd });
  assert.equal(foreignDuplicate.status, 1, foreignDuplicate.stdout + foreignDuplicate.stderr);
  assert.match(foreignDuplicate.stdout + foreignDuplicate.stderr, /already exists/);

  const slash = run(["tree", "add", "api", "feat/x"], { cwd });
  assert.equal(slash.status, 1, slash.stdout + slash.stderr);
  assert.match(slash.stdout + slash.stderr, /task names must not contain "\/"/);
  assert.equal(existsSync(join(cwd, ".oms-tree", "api", "feat")), false);

  const unknown = run(["tree", "add", "missing", "t"], { cwd });
  assert.equal(unknown.status, 1, unknown.stdout + unknown.stderr);
  assert.match(unknown.stdout + unknown.stderr, /Unknown alias "missing"/);
});

test("tree add works offline and asserts the exclude entry idempotently with no root commit", () => {
  const { cwd } = workspaceWithTree("only");
  const before = rootSnapshot(cwd);
  const excludePath = join(cwd, ".git", "info", "exclude");
  const excludeAfterFirstAdd = readFileSync(excludePath, "utf8");
  assert.match(excludeAfterFirstAdd, /\.oms-tree\//);

  // Creation uses only the submodule's local Git directory: an unreachable origin must not matter.
  git(join(cwd, "oms", "api"), "remote", "set-url", "origin", "http://127.0.0.1:9/unreachable");
  const offline = run(["tree", "add", "api", "offline-task"], { cwd });
  assert.equal(offline.status, 0, offline.stdout + offline.stderr);

  // Creating another tree must not duplicate the entry.
  run(["tree", "add", "api", "second"], { cwd });
  assert.equal(readFileSync(excludePath, "utf8"), excludeAfterFirstAdd);
  assertRootSnapshot(cwd, before);

  // Root status stays clean: .oms-tree/ is never untracked noise.
  const status = gitOut(cwd, "status", "--porcelain");
  assert.equal(status.includes(".oms-tree"), false, status);

  // Removing the last tree deletes the namespace root but keeps the exclude entry.
  run(["tree", "remove", "api", "only"], { cwd });
  run(["tree", "remove", "api", "offline-task"], { cwd });
  run(["tree", "remove", "api", "second"], { cwd });
  assert.equal(existsSync(join(cwd, ".oms-tree")), false);
  assert.match(readFileSync(excludePath, "utf8"), /\.oms-tree\//);
});

test("tree remove refuses a dirty worktree, force discards it, and both preserve the branch", () => {
  const { cwd, tree, task } = workspaceWithTree();

  writeFileSync(join(tree, "untracked.txt"), "x");
  const refused = run(["tree", "remove", "api", task], { cwd });
  const refusedOutput = refused.stdout + refused.stderr;
  assert.equal(refused.status, 1, refusedOutput);
  assert.match(refusedOutput, /has uncommitted changes/);
  assert.equal(existsSync(tree), true, "the dirty worktree is preserved");
  assert.equal(treeBranches(cwd).includes(task), true);

  const forced = run(["tree", "remove", "api", task, "--force"], { cwd });
  const forcedOutput = forced.stdout + forced.stderr;
  assert.equal(forced.status, 0, forcedOutput);
  assert.equal(existsSync(tree), false);
  assert.equal(treeBranches(cwd).includes(task), true, "force still preserves the branch");
  assert.match(forcedOutput, /oms tree add api t1/);
  assert.match(forcedOutput, /oms branch delete api t1/);
});

test("tree remove prunes a broken tree and cleans up empty parents through the namespace root", () => {
  const { cwd, task } = workspaceWithTree();
  const outer = join(cwd, "..");
  const moved = `${cwd}-moved`;

  // Break the link the way a real workspace move does: the administrative metadata still points
  // at the pre-move path, so porcelain reports the entry prunable at its old location.
  renameSync(cwd, moved);
  const listedBefore = run(["tree", "list"], { cwd: moved });
  const listedOutput = listedBefore.stdout + listedBefore.stderr;
  assert.equal(listedBefore.status, 0, listedOutput);
  assert.match(listedOutput, /api\s+t1\s+-\s+-\s+broken/, "the entry is detected as broken");

  const result = run(["tree", "remove", "api", task], { cwd: moved });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.equal(existsSync(join(moved, ".oms-tree", "api", task)), false);
  assert.equal(existsSync(join(moved, ".oms-tree")), false, "the namespace root is deleted");
  assert.match(output, /pruned/);
  assert.equal(
    gitOut(join(moved, "oms", "api"), "for-each-ref", "--format=%(refname:short)", `refs/heads/${task}`).trim(),
    task,
    "the branch survives pruning",
  );

  // The empty alias directory is cleaned when the last tree of an alias goes.
  run(["tree", "add", "api", "a"], { cwd: moved });
  run(["tree", "add", "api", "b"], { cwd: moved });
  run(["tree", "remove", "api", "a"], { cwd: moved });
  assert.equal(existsSync(join(moved, ".oms-tree", "api")), true, "the alias dir stays while b remains");
  run(["tree", "remove", "api", "b"], { cwd: moved });
  assert.equal(existsSync(join(moved, ".oms-tree", "api")), false);
});

test("tree remove refuses from inside the target tree and reports unknown trees", () => {
  const { cwd, tree, task } = workspaceWithTree();

  const inside = run(["tree", "remove", "api", task], { cwd: tree });
  const insideOutput = inside.stdout + inside.stderr;
  assert.equal(inside.status, 1, insideOutput);
  assert.match(insideOutput, /current directory is inside \.oms-tree\/api\/t1/);
  assert.equal(existsSync(tree), true, "the worktree and branch were preserved");

  const unknown = run(["tree", "remove", "api", "nope"], { cwd });
  const unknownOutput = unknown.stdout + unknown.stderr;
  assert.equal(unknown.status, 1, unknownOutput);
  assert.match(unknownOutput, /No managed tree at \.oms-tree\/api\/nope/);
  assert.match(unknownOutput, /oms tree list/);
});

test("tree remove deletes an empty foreign directory and refuses a non-empty one without force", () => {
  const { cwd } = workspaceWithTree();
  mkdirSync(join(cwd, ".oms-tree", "api", "empty-stray"), { recursive: true });
  mkdirSync(join(cwd, ".oms-tree", "api", "full-stray"), { recursive: true });
  writeFileSync(join(cwd, ".oms-tree", "api", "full-stray", "file.txt"), "keep me");

  const empty = run(["tree", "remove", "api", "empty-stray"], { cwd });
  assert.equal(empty.status, 0, empty.stdout + empty.stderr);
  assert.equal(existsSync(join(cwd, ".oms-tree", "api", "empty-stray")), false);

  const full = run(["tree", "remove", "api", "full-stray"], { cwd });
  const fullOutput = full.stdout + full.stderr;
  assert.equal(full.status, 1, fullOutput);
  assert.match(fullOutput, /not a registered worktree and contains files/);
  assert.equal(existsSync(join(cwd, ".oms-tree", "api", "full-stray", "file.txt")), true);

  const forced = run(["tree", "remove", "api", "full-stray", "--force"], { cwd });
  assert.equal(forced.status, 0, forced.stdout + forced.stderr);
  assert.equal(existsSync(join(cwd, ".oms-tree", "api", "full-stray")), false);
});

test("tree remove resolves omitted arguments interactively and fails non-interactively", () => {
  const { cwd, task } = workspaceWithTree("sel-a");
  run(["tree", "add", "api", "sel-b"], { cwd });

  // Non-interactive omission is a usage error naming the required arguments.
  const bare = run(["tree", "remove"], { cwd });
  const bareOutput = bare.stdout + bare.stderr;
  assert.equal(bare.status, 1, bareOutput);
  assert.match(bareOutput, /Usage error: "oms tree remove <alias> <task>"/);
  assert.equal(existsSync(join(cwd, ".oms-tree", "api", "sel-a")), true);
  assert.equal(existsSync(join(cwd, ".oms-tree", "api", "sel-b")), true);

  // Interactive: the alias first, then the task; a sole candidate is never auto-selected.
  const picked = run(["tree", "remove"], {
    cwd,
    env: queueEnv([{ type: "select", value: "api" }, { type: "select", value: "sel-b" }]),
  });
  const pickedOutput = picked.stdout + picked.stderr;
  assert.equal(picked.status, 0, pickedOutput);
  assert.equal(existsSync(join(cwd, ".oms-tree", "api", "sel-b")), false);
  assert.equal(existsSync(join(cwd, ".oms-tree", "api", "sel-a")), true);
});

test("tree list reports state for healthy, broken, and foreign entries and is a no-op when empty", () => {
  const { cwd } = workspaceWithTree();
  mkdirSync(join(cwd, ".oms-tree", "api", "stray"), { recursive: true });

  // Break one tree's link by moving the whole workspace (the relocation scenario).
  const listed = run(["tree", "list"], { cwd });
  const listedOutput = listed.stdout + listed.stderr;
  assert.equal(listed.status, 0, listedOutput);
  assert.match(listedOutput, /api\s+t1\s+t1\s+no\s+ok/);
  assert.match(listedOutput, /api\s+stray\s+-\s+-\s+not a registered worktree/);

  // After removing everything, the empty state reports none and exits 0.
  run(["tree", "remove", "api", "stray"], { cwd });
  run(["tree", "remove", "api", "t1"], { cwd });
  const empty = run(["tree", "list"], { cwd });
  const emptyOutput = empty.stdout + empty.stderr;
  assert.equal(empty.status, 0, emptyOutput);
  assert.match(emptyOutput, /No managed trees/);
});

// ─── cross-command contracts: guard, read-only availability, unsync, status, doctor ───

test("tree-cwd guard refuses alias commands before any mutation while read-only commands stay available", () => {
  const { cwd, tree } = workspaceWithTree();
  const before = rootSnapshot(cwd);
  const branchesBefore = treeBranches(cwd);

  const commit = run(["commit", "api", "-m", "x"], { cwd: tree });
  const commitOutput = commit.stdout + commit.stderr;
  assert.equal(commit.status, 1, commitOutput);
  assert.match(commitOutput, /inside a managed tree \(\.oms-tree\/\)/);
  assert.match(commitOutput, /Use Git directly inside the tree/);
  assert.match(commitOutput, /canonical checkout \(oms\/<alias>\/\) or the workspace root/);
  assert.equal(gitOut(tree, "status", "--porcelain"), "", "no commit or staging happened in the tree");
  assert.deepEqual(treeBranches(cwd), branchesBefore);

  // An omitted-alias command neither resolves nor prompts inside a tree.
  const record = run(["record"], { cwd: tree });
  assert.equal(record.status, 1, record.stdout + record.stderr);
  assert.match(record.stdout + record.stderr, /inside a managed tree/);

  // Bare `oms branch` fails before presenting the selector — no prompt is consumed.
  const bare = run(["branch"], { cwd: tree, env: queueEnv([{ type: "select", value: "list" }]) });
  assert.equal(bare.status, 1, bare.stdout + bare.stderr);
  assert.match(bare.stdout + bare.stderr, /inside a managed tree/);

  const push = run(["push", "api"], { cwd: tree });
  assert.equal(push.status, 1, push.stdout + push.stderr);
  assert.match(push.stdout + push.stderr, /inside a managed tree/);
  assertRootSnapshot(cwd, before);

  // Read-only commands stay available from inside the tree.
  const status = run(["status"], { cwd: tree });
  assert.equal(status.status, 0, status.stdout + status.stderr);
  const list = run(["tree", "list"], { cwd: tree });
  assert.equal(list.status, 0, list.stdout + list.stderr);
  assert.match(list.stdout + list.stderr, /api\s+t1\s+t1\s+no\s+ok/);
  const doctor = run(["doctor"], { cwd: tree });
  // Doctor may exit 2 for unrelated warnings (e.g. detached HEAD), but never the guard message.
  assert.doesNotMatch(doctor.stdout + doctor.stderr, /inside a managed tree/);
  assert.notEqual(doctor.status, 1);
});

test("unsync refuses while inventory entries exist, force included, and proceeds after removal", () => {
  const { cwd, tree } = workspaceWithTree();
  const before = rootSnapshot(cwd);

  const refused = run(["unsync", "api", "--no-commit"], { cwd });
  const refusedOutput = refused.stdout + refused.stderr;
  assert.equal(refused.status, 1, refusedOutput);
  assert.match(refusedOutput, /managed trees exist \(\.oms-tree\/api\/t1\)/);
  assert.match(refusedOutput, /oms tree remove api <task>/);
  assert.equal(existsSync(tree), true);
  assert.equal(existsSync(join(cwd, "oms", "api")), true);
  assertRootSnapshot(cwd, before);

  const forced = run(["unsync", "api", "--force", "--no-commit"], { cwd });
  const forcedOutput = forced.stdout + forced.stderr;
  assert.equal(forced.status, 1, forcedOutput);
  assert.match(forcedOutput, /managed trees exist/);

  // A foreign entry blocks too: it occupies the namespace and may be a lost tree.
  run(["tree", "remove", "api", "t1"], { cwd });
  mkdirSync(join(cwd, ".oms-tree", "api", "lost"), { recursive: true });
  const foreignBlocked = run(["unsync", "api", "--no-commit"], { cwd });
  const foreignOutput = foreignBlocked.stdout + foreignBlocked.stderr;
  assert.equal(foreignBlocked.status, 1, foreignOutput);
  assert.match(foreignOutput, /managed trees exist \(\.oms-tree\/api\/lost\)/);

  // After every entry is gone, unsync follows its normal topology policy.
  rmSync(join(cwd, ".oms-tree"), { recursive: true, force: true });
  const cleared = run(["unsync", "api", "--no-commit"], { cwd });
  assert.equal(cleared.status, 0, cleared.stdout + cleared.stderr);
  assert.equal(existsSync(join(cwd, "oms", "api")), false);
});

test("status --json exposes the trees array with filtering, broken entries, and foreign directories", () => {
  const { cwd } = workspaceWithApi();
  run(["tree", "add", "api", "t1"], { cwd });
  mkdirSync(join(cwd, ".oms-tree", "api", "stray"), { recursive: true });

  const all = JSON.parse(run(["status", "--json"], { cwd }).stdout);
  assert.equal(Array.isArray(all.trees), true);
  const t1 = all.trees.find((entry) => entry.task === "t1");
  assert.deepEqual(Object.keys(t1).sort(), [
    "absolutePath", "alias", "branch", "dirty", "error", "head", "path", "task",
  ]);
  assert.equal(t1.alias, "api");
  assert.equal(t1.branch, "t1");
  assert.equal(t1.dirty, false);
  assert.equal(t1.error, null);
  const stray = all.trees.find((entry) => entry.task === "stray");
  assert.equal(stray.error, "not a registered worktree of any submodule");

  // Alias filtering narrows the array.
  const narrowed = JSON.parse(run(["status", "--json", "api"], { cwd }).stdout);
  assert.equal(narrowed.trees.length, 2);

  // Without inventory entries the array is empty (remove the tree and the stray directory).
  run(["tree", "remove", "api", "t1"], { cwd });
  run(["tree", "remove", "api", "stray"], { cwd });
  const empty = JSON.parse(run(["status", "--json"], { cwd }).stdout);
  assert.deepEqual(empty.trees, []);

  // Human status lists trees when any exist.
  run(["tree", "add", "api", "t2"], { cwd });
  const human = run(["status"], { cwd });
  const humanOutput = human.stdout + human.stderr;
  assert.equal(human.status, 0, humanOutput);
  assert.match(humanOutput, /Managed trees \(\.oms-tree\/\)/);
  assert.match(humanOutput, /\.oms-tree\/api\/t2\s+t2\s+clean/);

  // An alias filter narrows the inventory to that alias, in JSON and in human output alike.
  const manifest = join(cwd, "oms.yaml");
  const declaredApi = readFileSync(manifest, "utf8");
  writeFileSync(manifest, declaredApi.replace(/alias: api/, "alias: web"));
  const otherAlias = JSON.parse(run(["status", "--json", "web"], { cwd }).stdout);
  assert.deepEqual(otherAlias.trees, []);
  assert.doesNotMatch(run(["status", "web"], { cwd }).stdout, /Managed trees/);

  // Without an alias filter the whole inventory is reported, including an undeclared alias's tree.
  const undeclared = JSON.parse(run(["status", "--json"], { cwd }).stdout);
  assert.deepEqual(undeclared.trees.map((entry) => `${entry.alias}/${entry.task}`), ["api/t2"]);
  assert.match(run(["status"], { cwd }).stdout, /\.oms-tree\/api\/t2\s+t2\s+clean/);
  writeFileSync(manifest, declaredApi);

  // Relocation breaks the link: the entry carries a non-null error and null fields.
  const moved = `${cwd}-moved`;
  renameSync(cwd, moved);
  const payload = JSON.parse(run(["status", "--json"], { cwd: moved }).stdout);
  const broken = payload.trees.find((entry) => entry.task === "t2");
  assert.equal(broken.error !== null, true);
  assert.match(broken.error, /worktree link is broken/);
  assert.equal(broken.branch, null);
  assert.equal(broken.head, null);
  assert.equal(broken.dirty, null);
});

test("doctor reports broken trees with repair guidance and a missing exclude entry", () => {
  const { cwd, task } = workspaceWithTree();
  const moved = `${cwd}-moved`;

  // Healthy tree: no broken-tree warning.
  const healthy = run(["doctor"], { cwd });
  const healthyOutput = healthy.stdout + healthy.stderr;
  assert.doesNotMatch(healthyOutput, /worktree link is broken/);

  // Broken tree (relocation): doctor names git worktree repair as the remediation.
  renameSync(cwd, moved);
  const broken = run(["doctor"], { cwd: moved });
  const brokenOutput = broken.stdout + broken.stderr;
  assert.match(brokenOutput, /\.oms-tree\/api\/t1: worktree link is broken/);
  assert.match(brokenOutput, /git -C oms\/api worktree repair/);

  // Missing exclude entry: doctor names oms tree add as the command that re-asserts it.
  writeFileSync(join(moved, ".git", "info", "exclude"), "# entry removed manually\n");
  const missingEntry = run(["doctor"], { cwd: moved });
  const missingOutput = missingEntry.stdout + missingEntry.stderr;
  assert.match(missingOutput, /local exclude entry is missing/);
  assert.match(missingOutput, /oms tree add/);
});
