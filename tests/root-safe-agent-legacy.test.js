import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { testEnv, run, tempWorkspace, writeSources, git, configIdentity, initBareUpstream, initGitWorkspace, gitOut, sourceFor, workspaceWithApi, skipUnreadable, agentWorkspace, sourcesFor, gitmodulesSectionCount } from "./helpers.js";
// --- root-safe sync/unsync topology and pull/push ---

test("sync leaves topology unstaged while preserving unrelated staged root changes", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  writeFileSync(join(cwd, "keep.txt"), "x");
  git(cwd, "add", "keep.txt"); // unrelated, pre-staged

  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const staged = gitOut(cwd, "diff", "--cached", "--name-only");
  assert.match(staged, /keep\.txt/); // preserved
  assert.doesNotMatch(staged, /\.gitmodules/); // topology unstaged
  assert.doesNotMatch(staged, /oms\/api/);
});

test("sync --commit creates a single-alias add topology commit", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));

  const result = run(["sync", "api", "--commit"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
});

test("sync --commit records pending add topology left by an earlier no-commit sync", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), ""); // left unstaged

  const result = run(["sync", "api", "--commit"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
});

test("sync --commit isolates unrelated staged root paths through the temporary index", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  writeFileSync(join(cwd, "keep.txt"), "x");
  git(cwd, "add", "keep.txt");

  // New behavior: the temp-index commit excludes unrelated staged paths and keeps them staged.
  const result = run(["sync", "api", "--commit"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
  // keep.txt was not committed and remains staged; the topology paths were consumed by the commit.
  const staged = gitOut(cwd, "diff", "--cached", "--name-only");
  assert.match(staged, /keep\.txt/);
  assert.doesNotMatch(staged, /\.gitmodules/);
  assert.doesNotMatch(staged, /oms\/api/);
  // keep.txt is not in the commit.
  assert.doesNotMatch(gitOut(cwd, "show", "--stat", "--pretty=format:", "HEAD"), /keep\.txt/);
});

test("multi-alias sync --commit creates one plural topology commit", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor([{ alias: "api", bare: a }, { alias: "web", bare: b }]));

  const result = run(["sync", "api", "web", "--commit"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add submodules");
});

test("multi-alias sync --commit finalizes the successful alias and excludes the failed one", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const cwd = initGitWorkspace();
  // web pins a nonexistent branch so its sync fails preflight; api succeeds.
  writeSources(
    cwd,
    `${sourceFor("api", a).trimEnd()}\n  - alias: web\n    remotes:\n      origin: file://${b}\n    branch: nope\n`,
  );

  const result = run(["sync", "api", "web", "--commit"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output); // web failed → overall non-zero
  // The successful alias is committed (singular message); the failed alias is not in the commit.
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
  const committed = gitOut(cwd, "show", "--name-only", "--pretty=format:", "HEAD");
  assert.match(committed, /oms\/api/);
  assert.doesNotMatch(committed, /oms\/web/);
});

test("unsync --commit creates a removal topology commit", () => {
  const { cwd } = workspaceWithApi();
  const result = run(["unsync", "api", "--commit"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): remove api submodule");
  assert.equal(existsSync(join(cwd, "oms", "api")), false);
});

test("unsync --commit records pending removal left by an earlier no-commit unsync", () => {
  const { cwd } = workspaceWithApi();
  assert.equal(run(["unsync", "api"], { cwd }).status, 0); // removal left unstaged
  assert.equal(existsSync(join(cwd, "oms", "api")), false);

  const result = run(["unsync", "api", "--commit"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): remove api submodule");
});

test("unsync --commit rejects partial removal topology it cannot complete", () => {
  const { cwd, wt } = workspaceWithApi();
  // Remove only the .gitmodules entry (partial) and dirty the submodule so unsync cannot finish.
  git(cwd, "config", "--file", ".gitmodules", "--remove-section", "submodule.oms/api");
  writeFileSync(join(wt, "dirty.txt"), "x");

  const result = run(["unsync", "api", "--commit"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /partial removal topology/i);
});

test("sync restores an uncommitted unsync instead of adding over the recorded gitlink", () => {
  const { cwd } = workspaceWithApi();
  assert.equal(run(["unsync", "api"], { cwd }).status, 0);
  assert.equal(existsSync(join(cwd, "oms", "api")), false);

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /restored pending removal/);
  assert.doesNotMatch(output, /already exists in the index/);
  assert.equal(existsSync(join(cwd, "oms", "api", ".git")), true);
  assert.equal(gitOut(cwd, "status", "--porcelain"), "");
});

test("sync restore is scoped to the selected alias and preserves unrelated .gitmodules edits", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor([{ alias: "api", bare: a }, { alias: "web", bare: b }]));
  assert.equal(run(["sync", "--all"], { cwd }).status, 0);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add submodules");
  writeFileSync(join(cwd, ".gitmodules"), `${readFileSync(join(cwd, ".gitmodules"), "utf8")}# keep web edit\n`);

  assert.equal(run(["unsync", "api"], { cwd }).status, 0);
  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);

  const modules = readFileSync(join(cwd, ".gitmodules"), "utf8");
  assert.match(modules, /oms\/api/);
  assert.match(modules, /oms\/web/);
  assert.match(modules, /# keep web edit/);
  assert.equal(existsSync(join(cwd, "oms", "web", ".git")), true);
});

test("sync restore preserves .gitmodules section order for a clean multi-alias restore", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const c = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor([{ alias: "api", bare: a }, { alias: "web", bare: b }, { alias: "docs", bare: c }]));
  assert.equal(run(["sync", "--all"], { cwd }).status, 0);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add submodules");

  assert.equal(run(["unsync", "api"], { cwd }).status, 0);
  assert.equal(run(["unsync", "web"], { cwd }).status, 0);
  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.equal(run(["sync", "web"], { cwd }).status, 0);

  assert.equal(gitOut(cwd, "status", "--porcelain"), "");
});

test("sync restore removes a metadata-only alias directory before initialization", () => {
  const { cwd } = workspaceWithApi();
  assert.equal(run(["unsync", "api"], { cwd }).status, 0);
  mkdirSync(join(cwd, "oms", "api"), { recursive: true });
  writeFileSync(join(cwd, "oms", "api", ".DS_Store"), "metadata");

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.equal(existsSync(join(cwd, "oms", "api", ".DS_Store")), false);
  assert.equal(gitOut(join(cwd, "oms", "api"), "status", "--porcelain"), "");
});

test("sync restores representative partial removal states", () => {
  {
    const { cwd } = workspaceWithApi();
    git(cwd, "config", "--file", ".gitmodules", "--remove-section", "submodule.oms/api");
    const result = run(["sync", "api"], { cwd });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(readFileSync(join(cwd, ".gitmodules"), "utf8"), /oms\/api/);
  }

  {
    const { cwd } = workspaceWithApi();
    rmSync(join(cwd, "oms", "api"), { recursive: true, force: true });
    const result = run(["sync", "api"], { cwd });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(existsSync(join(cwd, "oms", "api", ".git")), true);
  }
});

test("sync restore fails before add when a non-submodule path occupies the alias", () => {
  const { cwd } = workspaceWithApi();
  assert.equal(run(["unsync", "api"], { cwd }).status, 0);
  mkdirSync(join(cwd, "oms", "api"), { recursive: true });
  writeFileSync(join(cwd, "oms", "api", "file.txt"), "not a submodule");

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /cannot restore pending removal safely/);
  assert.doesNotMatch(output, /git submodule add failed/);
});

test("sync restore fails safely when a regular file occupies the alias", () => {
  const { cwd } = workspaceWithApi();
  assert.equal(run(["unsync", "api"], { cwd }).status, 0);
  mkdirSync(join(cwd, "oms"), { recursive: true });
  writeFileSync(join(cwd, "oms", "api"), "not a submodule");

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /cannot restore pending removal safely/);
  assert.doesNotMatch(output, /git submodule add failed/);
  assert.equal(readFileSync(join(cwd, "oms", "api"), "utf8"), "not a submodule");
});

test("sync restore fails before add when the selected root gitlink is conflicted", () => {
  const { cwd, wt } = workspaceWithApi();
  const base = gitOut(wt, "rev-parse", "HEAD");
  git(cwd, "checkout", "-b", "x");
  writeFileSync(join(wt, "b.txt"), "b");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "B");
  git(cwd, "add", "oms/api");
  git(cwd, "commit", "-m", "ptr B");
  git(cwd, "checkout", "main");
  git(wt, "reset", "--hard", base);
  writeFileSync(join(wt, "c.txt"), "c");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "C");
  git(cwd, "add", "oms/api");
  git(cwd, "commit", "-m", "ptr C");
  const merge = spawnSync("git", ["merge", "x"], { cwd, encoding: "utf8", env: testEnv });
  assert.notEqual(merge.status, 0, "merge should conflict on the gitlink");
  git(cwd, "config", "--file", ".gitmodules", "--remove-section", "submodule.oms/api");
  rmSync(join(cwd, "oms", "api"), { recursive: true, force: true });

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /root gitlink is conflicted/);
  assert.doesNotMatch(output, /git submodule add failed/);
});

test("sync restore fails before add during an in-progress root operation", () => {
  const { cwd } = workspaceWithApi();
  writeFileSync(join(cwd, "conflict.txt"), "base\n");
  git(cwd, "add", "conflict.txt");
  git(cwd, "commit", "-m", "base");
  git(cwd, "checkout", "-b", "other");
  writeFileSync(join(cwd, "conflict.txt"), "other\n");
  git(cwd, "commit", "-am", "other");
  git(cwd, "checkout", "main");
  writeFileSync(join(cwd, "conflict.txt"), "main\n");
  git(cwd, "commit", "-am", "main");
  const merge = spawnSync("git", ["merge", "other"], { cwd, encoding: "utf8", env: testEnv });
  assert.notEqual(merge.status, 0, "merge should conflict");
  git(cwd, "config", "--file", ".gitmodules", "--remove-section", "submodule.oms/api");
  rmSync(join(cwd, "oms", "api"), { recursive: true, force: true });

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /in progress/);
  assert.doesNotMatch(output, /git submodule add failed/);
});

test("sync restore reconciles manifest metadata as unstaged .gitmodules edits", () => {
  const { cwd, bare } = workspaceWithApi();
  writeSources(cwd, sourceFor("api", `${bare}/`));
  assert.equal(run(["unsync", "api"], { cwd }).status, 0);

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /reconciled \.gitmodules/);
  assert.match(readFileSync(join(cwd, ".gitmodules"), "utf8"), new RegExp(`url = file://${bare.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}/`));
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
  assert.match(gitOut(cwd, "diff", "--name-only"), /^\.gitmodules$/m);
});

test("unsync refuses and preserves a non-submodule path occupying the alias", () => {
  const { cwd } = workspaceWithApi();
  // Leave a pending removal (api unregistered), then drop a non-submodule file at oms/api.
  assert.equal(run(["unsync", "api"], { cwd }).status, 0);
  mkdirSync(join(cwd, "oms", "api"), { recursive: true });
  writeFileSync(join(cwd, "oms", "api", "file.txt"), "not a submodule");

  const result = run(["unsync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /occupied by a non-submodule/);
  // The occupying file is untouched, api is not reported as unsynced, and no dirty-tree cause leaks.
  assert.equal(readFileSync(join(cwd, "oms", "api", "file.txt"), "utf8"), "not a submodule");
  assert.doesNotMatch(output, /api: unsynced/);
  assert.doesNotMatch(output, /uncommitted or untracked changes/);
});

// chmod 0o000 is not enforced for root, so the unreadable-path cases cannot be provoked there.

test("unsync refuses when oms/<alias> is unreadable", skipUnreadable, () => {
  const { cwd } = workspaceWithApi();
  // Leave a pending removal (api unregistered), then make oms/api unreadable.
  assert.equal(run(["unsync", "api"], { cwd }).status, 0);
  mkdirSync(join(cwd, "oms", "api"), { recursive: true });
  chmodSync(join(cwd, "oms", "api"), 0o000);
  try {
    const result = run(["unsync", "api"], { cwd });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 2, output);
    assert.match(output, /could not be read \(permission or I\/O error\)/);
    // The misleading "occupied by a non-submodule path" wording is not used for an access error.
    assert.doesNotMatch(output, /occupied by a non-submodule/);
    assert.doesNotMatch(output, /api: unsynced/);
  } finally {
    chmodSync(join(cwd, "oms", "api"), 0o755);
  }
});

test("sync restore fails safely when oms/<alias> is unreadable", skipUnreadable, () => {
  const { cwd } = workspaceWithApi();
  assert.equal(run(["unsync", "api"], { cwd }).status, 0);
  mkdirSync(join(cwd, "oms", "api"), { recursive: true });
  chmodSync(join(cwd, "oms", "api"), 0o000);
  try {
    const result = run(["sync", "api"], { cwd });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 2, output);
    assert.match(output, /cannot restore pending removal safely/);
    assert.match(output, /could not be read \(permission or I\/O error\)/);
    assert.doesNotMatch(output, /git submodule add failed/);
  } finally {
    chmodSync(join(cwd, "oms", "api"), 0o755);
  }
});

test("sync fresh add fails when oms/<alias> is unreadable", skipUnreadable, () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  // api was never synced (no root gitlink), so this hits the fresh-add occupied check.
  mkdirSync(join(cwd, "oms", "api"), { recursive: true });
  chmodSync(join(cwd, "oms", "api"), 0o000);
  try {
    const result = run(["sync", "api"], { cwd });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 2, output);
    assert.match(output, /could not be read \(permission or I\/O error\)/);
    assert.doesNotMatch(output, /already exists but is not a registered/);
  } finally {
    chmodSync(join(cwd, "oms", "api"), 0o755);
  }
});

test("unsync refuses before deinit/rm during an in-progress root operation", () => {
  const { cwd } = workspaceWithApi();
  // A root-level merge conflict on a regular file leaves a merge in progress; the gitlink is clean.
  writeFileSync(join(cwd, "conflict.txt"), "base\n");
  git(cwd, "add", "conflict.txt");
  git(cwd, "commit", "-m", "base");
  git(cwd, "checkout", "-b", "other");
  writeFileSync(join(cwd, "conflict.txt"), "other\n");
  git(cwd, "commit", "-am", "other");
  git(cwd, "checkout", "main");
  writeFileSync(join(cwd, "conflict.txt"), "main\n");
  git(cwd, "commit", "-am", "main");
  const merge = spawnSync("git", ["merge", "other"], { cwd, encoding: "utf8", env: testEnv });
  assert.notEqual(merge.status, 0, "merge should conflict");

  const result = run(["unsync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /in progress/);
  assert.doesNotMatch(output, /uncommitted or untracked changes/);
  // The submodule is preserved: deinit/rm never ran.
  assert.equal(existsSync(join(cwd, "oms", "api", ".git")), true);
});

test("unsync refuses before deinit/rm when the root gitlink is conflicted", () => {
  const { cwd, wt } = workspaceWithApi();
  const base = gitOut(wt, "rev-parse", "HEAD");
  git(cwd, "checkout", "-b", "x");
  writeFileSync(join(wt, "b.txt"), "b");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "B");
  git(cwd, "add", "oms/api");
  git(cwd, "commit", "-m", "ptr B");
  git(cwd, "checkout", "main");
  git(wt, "reset", "--hard", base);
  writeFileSync(join(wt, "c.txt"), "c");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "C");
  git(cwd, "add", "oms/api");
  git(cwd, "commit", "-m", "ptr C");
  const merge = spawnSync("git", ["merge", "x"], { cwd, encoding: "utf8", env: testEnv });
  assert.notEqual(merge.status, 0, "merge should conflict on the gitlink");

  const result = run(["unsync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /conflicted/);
  assert.doesNotMatch(output, /uncommitted or untracked changes/);
  assert.equal(existsSync(join(cwd, "oms", "api", ".git")), true);
});

test("unsync still removes a normal registered submodule and leaves removal topology", () => {
  const { cwd } = workspaceWithApi();
  const result = run(["unsync", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /api: unsynced/);
  assert.equal(existsSync(join(cwd, "oms", "api")), false);
  // The removal is left unstaged by default (existing topology finalization policy); --commit records it.
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
  assert.equal(run(["unsync", "api", "--commit"], { cwd }).status, 0);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): remove api submodule");
});

test("pull rejects a dirty submodule before running", () => {
  const { cwd, wt } = workspaceWithApi();
  writeFileSync(join(wt, "dirty.txt"), "x");

  const result = run(["pull", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /uncommitted changes/);
});

test("pull rejects a detached submodule HEAD", () => {
  const { cwd, wt } = workspaceWithApi();
  git(wt, "checkout", "--detach");

  const result = run(["pull", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /detached HEAD/);
  assert.match(output, /oms branch switch api/);
});

test("pull advances the submodule branch without staging and hints record", () => {
  const { cwd, bare } = workspaceWithApi();
  // Advance origin/main from a scratch clone so there is something to pull.
  const scratch = mkdtempSync(join(tmpdir(), "oms-scratch-"));
  execFileSync("git", ["clone", bare, scratch], { stdio: "ignore", env: testEnv });
  configIdentity(scratch);
  writeFileSync(join(scratch, "up.txt"), "x");
  git(scratch, "add", "-A");
  git(scratch, "commit", "-m", "upstream");
  git(scratch, "push", "origin", "main");

  const result = run(["pull", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /pulled/);
  // No root staging; a record hint is printed because the pointer moved.
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
  assert.match(output, /oms record api/);
});

test("push warns about a dirty submodule but still pushes the current HEAD", () => {
  const { cwd, wt } = workspaceWithApi();
  writeFileSync(join(wt, "committed.txt"), "x");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "work");
  writeFileSync(join(wt, "dirty.txt"), "y"); // uncommitted

  const result = run(["push", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /only the current HEAD will be pushed/);
  assert.match(output, /pushed/);
});

// --- oms agent (managed instruction files) ---

/** A bare workspace (oms.yaml only, no git) — enough for agent file management. */

test("agent install --target both creates one managed block per file with the durable rules", () => {
  const cwd = agentWorkspace();
  const result = run(["agent", "install", "--target", "both"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);

  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const file = join(cwd, "oms", name);
    assert.ok(existsSync(file), `${name} should be created`);
    const content = readFileSync(file, "utf8");
    assert.equal(content.match(/<!-- OMS START -->/g).length, 1);
    assert.equal(content.match(/<!-- OMS END -->/g).length, 1);
    assert.ok(content.endsWith("\n") && !content.endsWith("\n\n"));
    // Durable rules per the spec scenario.
    assert.match(content, /oms status --json/);
    assert.match(content, /schemaVersion 2/);
    assert.match(content, /mode.*currentTarget/);
    assert.match(content, /alias\/name/);
    assert.match(content, /never guess/i);
    assert.match(content, /oms record <alias>/);
    assert.match(content, /oms <command> --help/);
  }
});

test("agent install requires --target in a non-interactive shell", () => {
  const cwd = agentWorkspace();
  const result = run(["agent", "install"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /--target/);
  assert.equal(existsSync(join(cwd, "oms", "AGENTS.md")), false);
});

test("agent install appends after two blank lines and preserves existing content", () => {
  const cwd = agentWorkspace();
  mkdirSync(join(cwd, "oms"), { recursive: true });
  writeFileSync(join(cwd, "oms", "AGENTS.md"), "# House rules\nBe nice.\n");

  assert.equal(run(["agent", "install", "--target", "agents"], { cwd }).status, 0);
  const content = readFileSync(join(cwd, "oms", "AGENTS.md"), "utf8");
  assert.match(content, /# House rules\nBe nice\.\n\n\n<!-- OMS START -->/);
  assert.ok(content.endsWith("<!-- OMS END -->\n"));
});

test("agent install replaces exactly one existing block and keeps outside content", () => {
  const cwd = agentWorkspace();
  assert.equal(run(["agent", "install", "--target", "agents"], { cwd }).status, 0);
  // Add content around the block, then re-install.
  const file = join(cwd, "oms", "AGENTS.md");
  writeFileSync(file, `Top matter.\n\n${readFileSync(file, "utf8")}\nBottom matter.\n`);
  assert.equal(run(["agent", "install", "--target", "agents"], { cwd }).status, 0);

  const content = readFileSync(file, "utf8");
  assert.equal(content.match(/<!-- OMS START -->/g).length, 1);
  assert.match(content, /Top matter\./);
  assert.match(content, /Bottom matter\./);
});

test("agent install does not stage the files in Git", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd);
  assert.equal(run(["agent", "install", "--target", "both"], { cwd }).status, 0);
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
  assert.match(gitOut(cwd, "status", "--porcelain"), /oms\//);
});

test("agent uninstall removes the block, deletes emptied files, and no-ops when absent", () => {
  const cwd = agentWorkspace();
  // AGENTS.md keeps surrounding content; CLAUDE.md becomes empty and is deleted.
  assert.equal(run(["agent", "install", "--target", "both"], { cwd }).status, 0);
  const agents = join(cwd, "oms", "AGENTS.md");
  writeFileSync(agents, `Keep me.\n\n${readFileSync(agents, "utf8")}`);

  assert.equal(run(["agent", "uninstall", "--target", "both"], { cwd }).status, 0);
  assert.equal(existsSync(join(cwd, "oms", "CLAUDE.md")), false); // emptied → deleted
  const content = readFileSync(agents, "utf8");
  assert.doesNotMatch(content, /<!-- OMS START -->/);
  assert.match(content, /Keep me\./);

  // Re-running uninstall is a clean no-op.
  const again = run(["agent", "uninstall", "--target", "both"], { cwd });
  const output = again.stdout + again.stderr;
  assert.equal(again.status, 0, output);
  assert.match(output, /no OMS block found/);
});

test("agent install rejects malformed markers atomically across targets", () => {
  const cwd = agentWorkspace();
  mkdirSync(join(cwd, "oms"), { recursive: true });
  // AGENTS.md is clean (no block); CLAUDE.md is malformed (start-only).
  writeFileSync(join(cwd, "oms", "AGENTS.md"), "# Clean file\n");
  writeFileSync(join(cwd, "oms", "CLAUDE.md"), "<!-- OMS START -->\norphan\n");

  const result = run(["agent", "install", "--target", "both"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /OMS marker|markers/);
  // No file was modified: AGENTS.md still has no block.
  assert.doesNotMatch(readFileSync(join(cwd, "oms", "AGENTS.md"), "utf8"), /<!-- OMS START -->/);
});

test("agent uninstall rejects a duplicate managed block atomically", () => {
  const cwd = agentWorkspace();
  mkdirSync(join(cwd, "oms"), { recursive: true });
  const dup = "<!-- OMS START -->\na\n<!-- OMS END -->\n<!-- OMS START -->\nb\n<!-- OMS END -->\n";
  writeFileSync(join(cwd, "oms", "CLAUDE.md"), dup);

  const result = run(["agent", "uninstall", "--target", "claude"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  // The malformed file is left untouched.
  assert.equal(readFileSync(join(cwd, "oms", "CLAUDE.md"), "utf8"), dup);
});

// --- command help boundaries ---

test("commit help explains submodule and worktree checkout scope with an example", () => {
  const result = run(["commit", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /selected submodule alias or worktree-mode alias\/name only/);
  assert.match(result.stdout, /staged-first/);
  assert.match(result.stdout, /oms commit api/);
});

test("record help explains the root-repository scope with an example", () => {
  const result = run(["record", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /ROOT repository only/);
  assert.match(result.stdout, /oms record api/);
});

test("push help explains the push/record separation and unsupported --commit", () => {
  const result = run(["push", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /never stages or commits the root gitlink/);
  assert.match(result.stdout, /not the same as recording a pointer commit/);
  assert.match(result.stdout, /unsupported/);
  assert.match(result.stdout, /oms record <alias>/);
});

test("pull help documents that it does not stage the root gitlink", () => {
  const result = run(["pull", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /never stages or commits the root gitlink/);
  assert.match(result.stdout, /oms record <alias>/);
});

test("status help documents the machine-readable --json mode", () => {
  const result = run(["status", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--json/);
  assert.match(result.stdout, /JSON object/);
});

test("status help documents the schemaVersion 2 field contract", () => {
  const result = run(["status", "--help"]);
  assert.equal(result.status, 0);
  // Names every schemaVersion 2 top-level key.
  for (const key of [
    "schemaVersion",
    "toolVersion",
    "workspaceRoot",
    "currentAlias",
    "currentWorktree",
    "currentTarget",
    "mode",
    "root",
    "repos",
    "errors",
  ]) {
    assert.ok(result.stdout.includes(key), `status --help should name top-level key ${key}`);
  }
  // Pointer arrays live under root.submodulePointers, never a top-level "pointers" key.
  assert.match(result.stdout, /root\.submodulePointers/);
  for (const arr of ["moved", "staged", "split", "conflict"]) {
    assert.ok(result.stdout.includes(arr), `status --help should name pointer array ${arr}`);
  }
  assert.doesNotMatch(result.stdout, /repos,\s*pointers/i);
});

test("sync and unsync help document the default-unstage and --commit topology behavior", () => {
  const sync = run(["sync", "--help"]);
  assert.match(sync.stdout, /left unstaged by default/);
  assert.match(sync.stdout, /--commit/);
  assert.match(sync.stdout, /oms sync api --commit/);

  const unsync = run(["unsync", "--help"]);
  assert.match(unsync.stdout, /left unstaged by default/);
  assert.match(unsync.stdout, /oms unsync api --commit/);
});

test("agent install help documents the managed instruction files", () => {
  const result = run(["agent", "install", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /AGENTS\.md/);
  assert.match(result.stdout, /CLAUDE\.md/);
  assert.match(result.stdout, /OMS START/);
  assert.match(result.stdout, /oms agent install --target both/);
});

test("unsync removes the submodule, keeps oms.yaml, and re-sync works", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));

  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add api");

  const unsynced = run(["unsync", "api"], { cwd });
  assert.equal(unsynced.status, 0, unsynced.stdout + unsynced.stderr);
  assert.equal(existsSync(join(cwd, "oms", "api")), false);
  // .gitmodules no longer registers oms/api (and is dropped when empty).
  if (existsSync(join(cwd, ".gitmodules"))) {
    assert.doesNotMatch(readFileSync(join(cwd, ".gitmodules"), "utf8"), /oms\/api/);
  }
  assert.match(readFileSync(join(cwd, "oms.yaml"), "utf8"), /alias: api/);

  // unsync now leaves the removal unstaged by default; commit it so re-sync starts from a clean index.
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "remove api");

  const resynced = run(["sync", "api"], { cwd });
  assert.equal(resynced.status, 0, resynced.stdout + resynced.stderr);
  assert.ok(existsSync(join(cwd, "oms", "api", ".git")));
  assert.equal(gitOut(join(cwd, "oms", "api"), "branch", "--show-current"), "main");
});

/** A multi-repo oms.yaml mapping each alias to its own bare origin. */


test("unsync of all aliases leaves no orphan .gitmodules section", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const c = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor([{ alias: "api", bare: a }, { alias: "web", bare: b }, { alias: "docs", bare: c }]));
  assert.equal(run(["sync", "--all"], { cwd }).status, 0);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add submodules");

  const result = run(["unsync", "api", "web", "docs"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitmodulesSectionCount(cwd), 0, "no submodule section should remain");
  assert.equal(existsSync(join(cwd, ".gitmodules")), false, ".gitmodules should be removed");
  assert.equal(existsSync(join(cwd, ".git", "modules", "oms")), false, ".git/modules/oms should be gone");
});

test("a dirty submodule among several is surfaced and only it remains", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const c = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor([{ alias: "api", bare: a }, { alias: "web", bare: b }, { alias: "docs", bare: c }]));
  assert.equal(run(["sync", "--all"], { cwd }).status, 0);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add submodules");

  // An untracked file (e.g. .DS_Store) makes web dirty, so it must be protected, not deleted.
  writeFileSync(join(cwd, "oms", "web", ".DS_Store"), "x");

  const result = run(["unsync", "api", "web", "docs"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  // The failed alias is named explicitly so it isn't lost among the successes.
  assert.match(output, /Not unsynced:.*web/);
  // web is preserved; api and docs are fully cleaned up.
  assert.equal(existsSync(join(cwd, "oms", "web")), true);
  assert.equal(existsSync(join(cwd, "oms", "api")), false);
  assert.equal(existsSync(join(cwd, "oms", "docs")), false);
  assert.equal(gitmodulesSectionCount(cwd), 1, "only web's section should remain");
  assert.match(readFileSync(join(cwd, ".gitmodules"), "utf8"), /oms\/web/);
  assert.doesNotMatch(readFileSync(join(cwd, ".gitmodules"), "utf8"), /oms\/api|oms\/docs/);
});

test("a committed pointer reproduces on a fresh clone via sync", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add api submodule");
  const pin = gitOut(cwd, "rev-parse", `:oms/api`);

  // Clone the parent elsewhere; the submodule is registered but not yet initialized.
  const clone = mkdtempSync(join(tmpdir(), "oms-clone-"));
  execFileSync("git", ["clone", cwd, clone], { stdio: "ignore", env: testEnv });
  configIdentity(clone);
  assert.equal(existsSync(join(clone, "oms", "api", ".git")), false);

  const result = run(["sync", "api"], { cwd: clone });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(join(clone, "oms", "api"), "rev-parse", "HEAD"), pin);
  assert.equal(gitOut(join(clone, "oms", "api"), "branch", "--show-current"), "main");
});

// --- legacy guards ---

test("legacy bare clone (oms/<alias>/.bare) blocks sync with the 0.6.0 migration hint", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  mkdirSync(join(cwd, "oms", "api", ".bare"), { recursive: true });

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /legacy bare clone/);
  assert.match(
    output,
    /https:\/\/github\.com\/divlook\/oh-my-space\/blob\/[^/\s]+\/docs\/migrations\/0\.5\.x-to-0\.6\.0\.md/,
  );
});

test("legacy sources.yaml without oms.yaml is blocked with migration hint", () => {
  const cwd = initGitWorkspace();
  writeFileSync(
    join(cwd, "sources.yaml"),
    "repos:\n  - alias: sample\n    url: git@example.com:org/repo.git\n    branch: main\n",
  );

  const result = run(["sync", "sample"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /detected legacy 'sources\.yaml'/);
  assert.match(
    output,
    /https:\/\/github\.com\/divlook\/oh-my-space\/blob\/[^/\s]+\/docs\/migrations\/0\.3\.x-to-0\.4\.0\.md/,
  );
});

test("legacy sources/ directory inside an oms.yaml workspace is blocked", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd);
  mkdirSync(join(cwd, "sources"));

  const result = run(["sync", "--list"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /detected legacy 'sources\/'/);
  assert.match(
    output,
    /https:\/\/github\.com\/divlook\/oh-my-space\/blob\/[^/\s]+\/docs\/migrations\/0\.3\.x-to-0\.4\.0\.md/,
  );
});

test("unrelated sources/ directory above the workspace does not block oms", () => {
  const parent = tempWorkspace();
  mkdirSync(join(parent, "sources"));
  const child = join(parent, "child");
  mkdirSync(child);
  execFileSync("git", ["init", "-b", "main", child], { stdio: "ignore", env: testEnv });
  writeSources(child);

  const result = run(["sync", "--list"], { cwd: child });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /sample/);
});
