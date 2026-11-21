import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { git, gitOut, queueEnv, run, sourcesFor, tempWorkspace, workspaceWithApi, writeSources } from "./helpers.js";

function workspaceWithTree(task = "t1") {
  const { cwd, bare, wt } = workspaceWithApi();
  const added = run(["tree", "add", "api", task], { cwd });
  assert.equal(added.status, 0, added.stdout + added.stderr);
  assert.equal(existsSync(join(cwd, ".oms-tree", "api", task)), true);
  return { cwd, bare, wt, tree: join(cwd, ".oms-tree", "api", task), task };
}

function rootSnapshot(cwd) {
  return {
    head: gitOut(cwd, "rev-parse", "HEAD"),
    index: gitOut(cwd, "ls-files", "--stage"),
    manifest: readFileSync(join(cwd, "oms.yaml"), "utf8"),
    gitmodules: existsSync(join(cwd, ".gitmodules"))
      ? readFileSync(join(cwd, ".gitmodules"), "utf8")
      : null,
  };
}

function assertRootSnapshot(cwd, before) {
  assert.deepEqual(rootSnapshot(cwd), before);
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
  assert.equal(output.split("\n").filter((line) => line.includes("created task tree")).length, 1);
  const second = join(cwd, ".oms-tree", "api", "second");
  assert.equal(existsSync(second), true);
  assert.equal(
    gitOut(join(cwd, "oms", "api"), "rev-parse", "HEAD"),
    gitOut(second, "rev-parse", "HEAD"),
    "the task branch starts at the canonical HEAD commit",
  );
  assert.equal(gitOut(second, "rev-parse", "--abbrev-ref", "HEAD"), "second");
  assert.equal(gitOut(join(cwd, "oms", "api"), "branch", "--show-current"), "main");
  assertRootSnapshot(cwd, before);

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

  const baseline = gitOut(wt, "rev-parse", "origin/main");
  git(wt, "commit", "--allow-empty", "-m", "canonical work");
  const canonical = gitOut(wt, "rev-parse", "HEAD");
  assert.notEqual(canonical, baseline);
  const fromResult = run(["tree", "add", "api", "from-task", "--from", "origin/main"], { cwd });
  assert.equal(fromResult.status, 0, fromResult.stdout + fromResult.stderr);
  assert.equal(gitOut(join(cwd, ".oms-tree", "api", "from-task"), "rev-parse", "HEAD"), baseline);
  assert.equal(gitOut(wt, "rev-parse", "HEAD"), canonical);

  const remove = run(["tree", "remove", "api", "t1"], { cwd });
  assert.equal(remove.status, 0, remove.stdout + remove.stderr);
  assert.equal(treeBranches(cwd).includes("t1"), true, "the branch survives removal");

  const conflict = run(["tree", "add", "api", "t1", "--from", "origin/main"], { cwd });
  const conflictOutput = conflict.stdout + conflict.stderr;
  assert.equal(conflict.status, 1, conflictOutput);
  assert.match(conflictOutput, /branch "t1" already exists.*[Oo]mit --from/);
  assert.equal(existsSync(join(cwd, ".oms-tree", "api", "t1")), false, "no worktree was created");

  const resume = run(["tree", "add", "api", "t1"], { cwd });
  const resumeOutput = resume.stdout + resume.stderr;
  assert.equal(resume.status, 0, resumeOutput);
  assert.match(resumeOutput, /resumed branch t1/);
  assert.equal(gitOut(join(cwd, ".oms-tree", "api", "t1"), "rev-parse", "HEAD"), baseline);
  assert.equal(existsSync(bare), true);
});

test("tree add refuses duplicate paths including foreign directories, invalid names, and unknown aliases", () => {
  const { cwd, bare } = workspaceWithTree();

  const duplicate = run(["tree", "add", "api", "t1"], { cwd });
  const duplicateOutput = duplicate.stdout + duplicate.stderr;
  assert.equal(duplicate.status, 1, duplicateOutput);
  assert.match(duplicateOutput, /A managed tree already exists at \.oms-tree\/api\/t1/);
  assert.match(duplicateOutput, /oms tree remove api t1/);

  mkdirSync(join(cwd, ".oms-tree", "api", "stray"), { recursive: true });
  const foreignDuplicate = run(["tree", "add", "api", "stray"], { cwd });
  assert.equal(foreignDuplicate.status, 1, foreignDuplicate.stdout + foreignDuplicate.stderr);
  assert.match(foreignDuplicate.stdout + foreignDuplicate.stderr, /already exists/);

  const slash = run(["tree", "add", "api", "feat/x"], { cwd });
  assert.equal(slash.status, 1, slash.stdout + slash.stderr);
  assert.match(slash.stdout + slash.stderr, /task names must not contain "\/"/);
  assert.equal(existsSync(join(cwd, ".oms-tree", "api", "feat")), false);

  const invalidRef = run(["tree", "add", "api", "a..b"], { cwd });
  assert.equal(invalidRef.status, 1, invalidRef.stdout + invalidRef.stderr);
  assert.match(invalidRef.stdout + invalidRef.stderr, /valid branch name/);
  assert.equal(existsSync(join(cwd, ".oms-tree", "api", "a..b")), false);

  const unknown = run(["tree", "add", "missing", "t"], { cwd });
  assert.equal(unknown.status, 1, unknown.stdout + unknown.stderr);
  assert.match(unknown.stdout + unknown.stderr, /Unknown alias "missing"/);

  writeSources(cwd, sourcesFor(["api", "missing"].map((alias) => ({ alias, bare }))));
  const notCloned = run(["tree", "add", "missing", "t"], { cwd });
  assert.equal(notCloned.status, 1, notCloned.stdout + notCloned.stderr);
  assert.match(notCloned.stdout + notCloned.stderr, /oms clone missing/);
  assert.equal(existsSync(join(cwd, "oms", "missing")), false);
  assert.equal(existsSync(join(cwd, ".oms-tree", "missing")), false);

  rmSync(join(cwd, ".oms-tree", "api", "t1"), { recursive: true });
  const api = join(cwd, "oms", "api");
  const before = rootSnapshot(cwd);
  const index = readFileSync(join(cwd, ".git", "index"));
  const branch = gitOut(api, "rev-parse", "t1");
  const registration = gitOut(api, "worktree", "list", "--porcelain");
  const brokenDuplicate = run(["tree", "add", "api", "t1"], { cwd });
  assert.equal(brokenDuplicate.status, 1, brokenDuplicate.stdout + brokenDuplicate.stderr);
  assert.equal(existsSync(join(cwd, ".oms-tree", "api", "t1")), false);
  assert.equal(gitOut(api, "rev-parse", "t1"), branch);
  assert.equal(gitOut(api, "worktree", "list", "--porcelain"), registration);
  assert.deepEqual(readFileSync(join(cwd, ".git", "index")), index);
  assertRootSnapshot(cwd, before);
});

test("tree add works offline and asserts the exclude entry idempotently with no root commit", () => {
  const { cwd, bare } = workspaceWithTree("only");
  const before = rootSnapshot(cwd);
  const excludePath = join(cwd, ".git", "info", "exclude");
  const excludeAfterFirstAdd = readFileSync(excludePath, "utf8");
  assert.match(excludeAfterFirstAdd, /\.oms-tree\//);

  renameSync(bare, `${bare}-offline`);
  const offline = run(["tree", "add", "api", "offline-task"], { cwd });
  assert.equal(offline.status, 0, offline.stdout + offline.stderr);

  run(["tree", "add", "api", "second"], { cwd });
  assert.equal(readFileSync(excludePath, "utf8"), excludeAfterFirstAdd);
  assertRootSnapshot(cwd, before);

  const status = gitOut(cwd, "status", "--porcelain");
  assert.equal(status.includes(".oms-tree"), false, status);

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
  const moved = `${cwd}-moved`;

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
  assert.match(output, /stale metadata removed/);
  assert.equal(
    gitOut(join(moved, "oms", "api"), "for-each-ref", "--format=%(refname:short)", `refs/heads/${task}`).trim(),
    task,
    "the branch survives pruning",
  );

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
  assert.match(fullOutput, /not a registered worktree and is not an empty directory/);
  assert.equal(existsSync(join(cwd, ".oms-tree", "api", "full-stray", "file.txt")), true);

  const forced = run(["tree", "remove", "api", "full-stray", "--force"], { cwd });
  assert.equal(forced.status, 0, forced.stdout + forced.stderr);
  assert.equal(existsSync(join(cwd, ".oms-tree", "api", "full-stray")), false);
});

test("tree remove resolves omitted arguments interactively and fails non-interactively", () => {
  const { cwd } = workspaceWithTree("sel-a");
  run(["tree", "add", "api", "sel-b"], { cwd });

  const bare = run(["tree", "remove"], { cwd });
  const bareOutput = bare.stdout + bare.stderr;
  assert.equal(bare.status, 1, bareOutput);
  assert.match(bareOutput, /Usage error: "oms tree remove <alias> <task>"/);
  assert.equal(existsSync(join(cwd, ".oms-tree", "api", "sel-a")), true);
  assert.equal(existsSync(join(cwd, ".oms-tree", "api", "sel-b")), true);

  const picked = run(["tree", "remove"], {
    cwd,
    env: queueEnv([{ type: "select", value: "api" }, { type: "select", value: "sel-b" }]),
  });
  const pickedOutput = picked.stdout + picked.stderr;
  assert.equal(picked.status, 0, pickedOutput);
  assert.equal(existsSync(join(cwd, ".oms-tree", "api", "sel-b")), false);
  assert.equal(existsSync(join(cwd, ".oms-tree", "api", "sel-a")), true);
});

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

  const exec = run(["exec", "api", "--", process.execPath, "-e", "require('fs').writeFileSync('ran', 'yes')"], { cwd: tree });
  assert.equal(exec.status, 1, exec.stdout + exec.stderr);
  assert.match(exec.stdout + exec.stderr, /inside a managed tree/);
  assert.equal(existsSync(join(cwd, "oms", "api", "ran")), false);
  assert.equal(existsSync(join(tree, "ran")), false);

  const bare = run(["branch"], { cwd: tree, env: queueEnv([{ type: "select", value: "list" }]) });
  assert.equal(bare.status, 1, bare.stdout + bare.stderr);
  assert.match(bare.stdout + bare.stderr, /inside a managed tree/);

  const push = run(["push", "api"], { cwd: tree });
  assert.equal(push.status, 1, push.stdout + push.stderr);
  assert.match(push.stdout + push.stderr, /inside a managed tree/);
  assertRootSnapshot(cwd, before);

  const status = run(["status", "--json"], { cwd: tree });
  assert.equal(status.status, 0, status.stdout + status.stderr);
  const json = JSON.parse(status.stdout);
  assert.equal(json.schemaVersion, 2);
  assert.equal(json.currentAlias, null);
  assert.equal(Object.hasOwn(json.root, "submodulePointers"), false);
  assert.equal(Object.hasOwn(json.repos[0], "pin"), false);
  assert.deepEqual(json.trees.map(({ alias, task }) => [alias, task]), [["api", "t1"]]);
  const unknownStatus = run(["status", "missing", "--json"], { cwd: tree });
  assert.equal(unknownStatus.status, 1, unknownStatus.stdout + unknownStatus.stderr);
  assert.equal(unknownStatus.stdout, "");
  assert.match(unknownStatus.stderr, /Unknown alias.*missing/);
  assert.match(unknownStatus.stderr, /oms clone --list/);
  const list = run(["tree", "list"], { cwd: tree });
  assert.equal(list.status, 0, list.stdout + list.stderr);
  assert.match(list.stdout + list.stderr, /api\s+t1\s+t1\s+no\s+ok/);
  const doctor = run(["doctor"], { cwd: tree });
  assert.doesNotMatch(doctor.stdout + doctor.stderr, /inside a managed tree/);
  assert.notEqual(doctor.status, 1);
});

test("remove refuses while inventory entries exist, force included, and proceeds after removal", () => {
  const { cwd, tree } = workspaceWithTree();
  const before = rootSnapshot(cwd);

  const refused = run(["remove", "api", "--yes"], { cwd });
  const refusedOutput = refused.stdout + refused.stderr;
  assert.equal(refused.status, 2, refusedOutput);
  assert.match(refusedOutput, /managed tree \.oms-tree\/api\/t1 exists/);
  assert.match(refusedOutput, /oms tree remove/);
  assert.equal(existsSync(tree), true);
  assert.equal(existsSync(join(cwd, "oms", "api")), true);
  assertRootSnapshot(cwd, before);

  const forced = run(["remove", "api", "--force", "--yes"], { cwd });
  const forcedOutput = forced.stdout + forced.stderr;
  assert.equal(forced.status, 2, forcedOutput);
  assert.match(forcedOutput, /managed tree \.oms-tree\/api\/t1 exists/);

  rmSync(tree, { recursive: true });
  const api = join(cwd, "oms", "api");
  const index = readFileSync(join(cwd, ".git", "index"));
  const branch = gitOut(api, "rev-parse", "t1");
  const registration = gitOut(api, "worktree", "list", "--porcelain");
  for (const force of [false, true]) {
    const brokenBlocked = run(["remove", "api", ...(force ? ["--force"] : []), "--yes"], { cwd });
    const output = brokenBlocked.stdout + brokenBlocked.stderr;
    assert.equal(brokenBlocked.status, 2, output);
    assert.match(output, /\.oms-tree\/api\/t1/);
    assert.equal(existsSync(join(api, ".git")), true);
    assert.equal(gitOut(api, "rev-parse", "t1"), branch);
    assert.equal(gitOut(api, "worktree", "list", "--porcelain"), registration);
    assert.deepEqual(readFileSync(join(cwd, ".git", "index")), index);
    assertRootSnapshot(cwd, before);
  }

  run(["tree", "remove", "api", "t1"], { cwd });
  mkdirSync(join(cwd, ".oms-tree", "api", "lost"), { recursive: true });
  const foreignBlocked = run(["remove", "api", "--force", "--yes"], { cwd });
  const foreignOutput = foreignBlocked.stdout + foreignBlocked.stderr;
  assert.equal(foreignBlocked.status, 2, foreignOutput);
  assert.match(foreignOutput, /managed tree \.oms-tree\/api\/lost exists/);

  rmSync(join(cwd, ".oms-tree"), { recursive: true });
  const external = join(tempWorkspace(), ".oms-tree", "api", "external");
  git(api, "worktree", "add", "-b", "external", external);
  const listed = run(["tree", "list"], { cwd });
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  assert.match(listed.stdout + listed.stderr, /No managed trees/);
  const externalBlocked = run(["remove", "api", "--force", "--yes"], { cwd });
  const externalOutput = externalBlocked.stdout + externalBlocked.stderr;
  assert.equal(externalBlocked.status, 2, externalOutput);
  assert.match(externalOutput, /linked worktree .*\/\.oms-tree\/api\/external exists/);
  assert.equal(existsSync(join(api, ".git")), true);
  assert.equal(existsSync(join(external, ".git")), true);
  git(api, "worktree", "remove", external);

  const cleared = run(["remove", "api", "--yes"], { cwd });
  assert.equal(cleared.status, 0, cleared.stdout + cleared.stderr);
  assert.equal(existsSync(api), false);
  assertRootSnapshot(cwd, before);
});

test("doctor reports broken trees with repair guidance and a missing exclude entry", () => {
  const { cwd } = workspaceWithTree();
  const moved = `${cwd}-moved`;

  const healthy = run(["doctor"], { cwd });
  const healthyOutput = healthy.stdout + healthy.stderr;
  assert.doesNotMatch(healthyOutput, /worktree link is broken/);

  renameSync(cwd, moved);
  const broken = run(["doctor"], { cwd: moved });
  const brokenOutput = broken.stdout + broken.stderr;
  assert.match(brokenOutput, /\.oms-tree\/api\/t1: (?:worktree link is broken|gitdir file points to non-existent location)/);
  assert.match(brokenOutput, /git -C oms\/api worktree repair/);

  writeFileSync(join(moved, ".git", "info", "exclude"), "# entry removed manually\n");
  const missingEntry = run(["doctor"], { cwd: moved });
  const missingOutput = missingEntry.stdout + missingEntry.stderr;
  assert.match(missingOutput, /local exclude entry is missing/);
  assert.match(missingOutput, /oms tree add/);
});
