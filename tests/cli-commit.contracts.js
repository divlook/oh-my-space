import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import test from "./sharded-test.js";
import assert from "node:assert/strict";
import semver from "semver";
import { parse as parseYaml } from "yaml";
import {
  cli,
  publishBetaScript,
  testEnv,
  currentVersion,
  newerVersion,
  run,
  versionPattern,
  updateEnv,
  queueEnv,
  installContext,
  tempFixture,
  tempWorkspace,
  writeSources,
  git,
  configIdentity,
  initBareUpstream,
  initGitWorkspace,
  gitOut,
  initEmptyBare,
  sourceFor,
  gitTopLevelStubEnv,
  workspaceWithApi,
  statusJson,
  workspaceWithMovedApi,
  sourcesFor,
  gitmodulesSectionCount,
  syncedSubmodule,
  localBranchExists,
} from "./helpers.js";

// --- oms commit (submodule source commits only) ---

test("commit stages all submodule changes when nothing is staged and leaves the root untouched", () => {
  const { cwd } = workspaceWithApi();
  const wt = join(cwd, "oms", "api");
  writeFileSync(join(wt, "new.txt"), "hi");

  const rootHeadBefore = gitOut(cwd, "rev-parse", "HEAD");
  const result = run(["commit", "api", "-m", "feat: add login flow"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  // A submodule commit was created.
  assert.equal(gitOut(wt, "log", "-1", "--pretty=%s"), "feat: add login flow");
  assert.match(output, /committed [0-9a-f]+/);
  // The root received no commit and nothing is staged; only the working-tree gitlink moved.
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootHeadBefore);
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
  assert.match(gitOut(cwd, "status", "--porcelain"), /oms\/api/);
  // The follow-up hint points at record.
  assert.match(output, /oms record api/);
});

test("commit respects an existing submodule index and warns about leftovers", () => {
  const { cwd } = workspaceWithApi();
  const wt = join(cwd, "oms", "api");
  writeFileSync(join(wt, "staged.txt"), "a");
  writeFileSync(join(wt, "left.txt"), "b");
  git(wt, "add", "staged.txt"); // only one file staged

  const result = run(["commit", "api", "-m", "feat: only staged"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  // Only the staged file landed in the commit.
  const files = gitOut(wt, "show", "--name-only", "--pretty=format:", "HEAD").trim();
  assert.match(files, /staged\.txt/);
  assert.doesNotMatch(files, /left\.txt/);
  // The leftover remains and the user is warned.
  assert.match(gitOut(wt, "status", "--porcelain"), /left\.txt/);
  assert.match(output, /unstaged or untracked changes remain/);
});

test("commit passes multiple -m paragraphs through to the submodule commit", () => {
  const { cwd } = workspaceWithApi();
  const wt = join(cwd, "oms", "api");
  writeFileSync(join(wt, "f.txt"), "x");

  const result = run(["commit", "api", "-m", "feat: add login", "-m", "Add callback handling."], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const body = gitOut(wt, "log", "-1", "--pretty=%B");
  assert.match(body, /feat: add login/);
  assert.match(body, /Add callback handling\./);
});

test("commit without -m fails for a dirty submodule and is a no-op for a clean one", () => {
  const { cwd } = workspaceWithApi();
  const wt = join(cwd, "oms", "api");

  // Clean submodule: no -m needed, reports nothing to commit, exits 0.
  let result = run(["commit", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Nothing to commit for api/);

  // Dirty submodule without -m fails without opening an editor.
  writeFileSync(join(wt, "f.txt"), "x");
  result = run(["commit", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /-m is required/);
});

test("commit no-op prints a record hint when the pointer already moved", () => {
  const { cwd } = workspaceWithApi();
  const wt = join(cwd, "oms", "api");
  // Move the pointer with a raw git commit so oms commit sees no new changes.
  writeFileSync(join(wt, "f.txt"), "x");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "raw work");

  const result = run(["commit", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Nothing to commit for api/);
  assert.match(output, /oms record api/);
});

test("commit prints a topology hint instead of record when the root gitlink is unrecorded", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  // Deliberately do NOT record the gitlink in the root HEAD (pending add topology).
  const wt = join(cwd, "oms", "api");
  writeFileSync(join(wt, "f.txt"), "x");

  const result = run(["commit", "api", "-m", "feat: work"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /oms sync api --commit/);
  assert.doesNotMatch(output, /oms record api/);
});

test("commit rejects a detached submodule HEAD without touching the root", () => {
  const { cwd } = workspaceWithApi();
  const wt = join(cwd, "oms", "api");
  git(wt, "checkout", "--detach");
  const rootHeadBefore = gitOut(cwd, "rev-parse", "HEAD");

  const result = run(["commit", "api", "-m", "x"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /detached HEAD/);
  assert.match(output, /oms branch switch api/);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootHeadBefore);
});

test("commit rejects an in-progress merge inside the submodule", () => {
  const { cwd } = workspaceWithApi();
  const wt = join(cwd, "oms", "api");
  writeFileSync(join(wt, "conflict.txt"), "base\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "base");
  git(wt, "checkout", "-b", "other");
  writeFileSync(join(wt, "conflict.txt"), "other\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "other");
  git(wt, "checkout", "main");
  writeFileSync(join(wt, "conflict.txt"), "main\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "main");
  const merge = spawnSync("git", ["merge", "other"], { cwd: wt, encoding: "utf8", env: testEnv });
  assert.notEqual(merge.status, 0, "merge should conflict");

  const rootHeadBefore = gitOut(cwd, "rev-parse", "HEAD");
  const result = run(["commit", "api", "-m", "x"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /merge is in progress/);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootHeadBefore);
});

test("commit infers the alias from the current submodule directory", () => {
  const { cwd } = workspaceWithApi();
  const wt = join(cwd, "oms", "api");
  writeFileSync(join(wt, "f.txt"), "x");

  // No alias argument: inferred from cwd being inside oms/api.
  const result = run(["commit", "-m", "feat: inferred"], { cwd: wt });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(wt, "log", "-1", "--pretty=%s"), "feat: inferred");
});

test("commit gives an explicit alias precedence over the current submodule context", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(
    cwd,
    `repos:\n  - alias: api\n    remotes:\n      origin: file://${bare}\n    branch: main\n  - alias: web\n    remotes:\n      origin: file://${bare}\n    branch: main\n`,
  );
  assert.equal(run(["sync", "api", "web"], { cwd }).status, 0);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add submodules");
  writeFileSync(join(cwd, "oms", "web", "web.txt"), "web");

  const result = run(["commit", "web", "-m", "feat: explicit web"], {
    cwd: join(cwd, "oms", "api"),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(join(cwd, "oms", "web"), "log", "-1", "--pretty=%s"), "feat: explicit web");
  assert.notEqual(gitOut(join(cwd, "oms", "api"), "log", "-1", "--pretty=%s"), "feat: explicit web");
});

test("commit infers the alias before preconditions and fails when uninitialized", () => {
  const { cwd } = workspaceWithApi();
  const clone = tempFixture("oms-clone-");
  execFileSync("git", ["clone", cwd, clone], { stdio: "ignore", env: testEnv });
  configIdentity(clone);
  // oms/api exists as an uninitialized submodule directory in the fresh clone.
  const result = run(["commit", "-m", "x"], { cwd: join(clone, "oms", "api") });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /not initialized/);
  assert.match(output, /oms sync api/);
});

test("commit without an alias outside any submodule fails in a non-TTY shell", () => {
  const { cwd } = workspaceWithApi();
  const result = run(["commit", "-m", "x"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /alias/i);
  assert.match(output, /not a TTY/);
});

// --- oms record (root gitlink pointer commits only) ---


test("record commits only the moved gitlink with a conventional message", () => {
  const { cwd, wt } = workspaceWithMovedApi();
  const sha = gitOut(wt, "rev-parse", "--short", "HEAD");

  const result = run(["record", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), `chore(oms): update api submodule to ${sha}`);
  assert.match(output, new RegExp(`chore\\(oms\\): update api submodule to ${sha}`));
  // Only oms/api was committed and the working tree is clean of the pointer move.
  assert.equal(gitOut(cwd, "show", "--name-only", "--pretty=format:", "HEAD").trim(), "oms/api");
  assert.equal(gitOut(cwd, "status", "--porcelain"), "");
});

test("record is a no-op without pointer movement and does not warn for dirty source", () => {
  const { cwd } = workspaceWithApi();
  // Uncommitted source change but no pointer movement.
  writeFileSync(join(cwd, "oms", "api", "dirty.txt"), "x");
  const rootHeadBefore = gitOut(cwd, "rev-parse", "HEAD");

  const result = run(["record", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Nothing to record for api/);
  assert.doesNotMatch(output, /uncommitted source/);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootHeadBefore);
});

test("record warns about a dirty submodule but still records the current HEAD", () => {
  const { cwd, wt } = workspaceWithMovedApi();
  writeFileSync(join(wt, "extra.txt"), "uncommitted");
  const sha = gitOut(wt, "rev-parse", "--short", "HEAD");

  const result = run(["record", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /only the current HEAD pointer will be recorded/);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), `chore(oms): update api submodule to ${sha}`);
});

test("record rejects unrelated staged root changes", () => {
  const { cwd } = workspaceWithMovedApi();
  writeFileSync(join(cwd, "root.txt"), "x");
  git(cwd, "add", "root.txt");
  const rootHeadBefore = gitOut(cwd, "rev-parse", "HEAD");

  const result = run(["record", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /unrelated staged changes/);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootHeadBefore);
});

test("record allows unrelated unstaged root changes and stays path-limited", () => {
  const { cwd } = workspaceWithMovedApi();
  writeFileSync(join(cwd, "root.txt"), "x"); // unrelated, unstaged

  const result = run(["record", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // Only oms/api was committed; the unrelated file is still uncommitted.
  assert.equal(gitOut(cwd, "show", "--name-only", "--pretty=format:", "HEAD").trim(), "oms/api");
  assert.match(gitOut(cwd, "status", "--porcelain"), /root\.txt/);
});

test("record allows an already-staged selected gitlink that matches the working tree", () => {
  const { cwd } = workspaceWithMovedApi();
  git(cwd, "add", "oms/api"); // pre-stage the selected gitlink

  const result = run(["record", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(gitOut(cwd, "log", "-1", "--pretty=%s"), /update api submodule/);
});

test("record rejects a staged gitlink for a different alias", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor([{ alias: "api", bare: a }, { alias: "web", bare: b }]));
  assert.equal(run(["sync", "--all"], { cwd }).status, 0);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add submodules");
  // Move both pointers, then stage only web's gitlink.
  for (const alias of ["api", "web"]) {
    writeFileSync(join(cwd, "oms", alias, "f.txt"), "x");
    git(join(cwd, "oms", alias), "add", "-A");
    git(join(cwd, "oms", alias), "commit", "-m", "work");
  }
  git(cwd, "add", "oms/web");

  const result = run(["record", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /unrelated staged changes.*oms\/web/);
});

// --- multi-alias record ---

/** A workspace with api/web/core synced and their topology committed, so every gitlink exists in HEAD. */
function workspaceWithThree() {
  const bares = { api: initBareUpstream(), web: initBareUpstream(), core: initBareUpstream() };
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor(Object.entries(bares).map(([alias, bare]) => ({ alias, bare }))));
  assert.equal(run(["sync", "--all"], { cwd }).status, 0);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add submodules");
  return { cwd, bares };
}

/** Advance one submodule's working commit so its root pointer becomes moved. */
function movePointer(cwd, alias, content = "x") {
  const wt = join(cwd, "oms", alias);
  writeFileSync(join(wt, "f.txt"), content);
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "work");
}

test("record with several aliases creates one plural root commit", () => {
  const { cwd } = workspaceWithThree();
  for (const alias of ["api", "web", "core"]) movePointer(cwd, alias);

  const result = run(["record", "api", "web", "core"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): update submodules");
  // One commit carrying all three gitlinks.
  const committed = gitOut(cwd, "show", "--name-only", "--pretty=format:", "HEAD");
  for (const alias of ["api", "web", "core"]) assert.match(committed, new RegExp(`oms/${alias}`));
  assert.equal(gitOut(cwd, "rev-list", "--count", "HEAD"), "3"); // template + topology + one record
});

test("record --all records every moved pointer and leaves unmoved ones alone", () => {
  const { cwd } = workspaceWithThree();
  movePointer(cwd, "web");

  const result = run(["record", "--all"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  // Only web moved, so the singular message is used and the unmoved aliases raise no problem.
  assert.match(gitOut(cwd, "log", "-1", "--pretty=%s"), /update web submodule/);
  const committed = gitOut(cwd, "show", "--name-only", "--pretty=format:", "HEAD");
  assert.match(committed, /oms\/web/);
  assert.doesNotMatch(committed, /oms\/(api|core)/);
});

test("record --all with nothing moved is a no-op", () => {
  const { cwd } = workspaceWithThree();
  const before = gitOut(cwd, "rev-parse", "HEAD");

  const result = run(["record", "--all"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Nothing to record for any submodule/);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), before);
});

test("record --all skips an alias with no recorded gitlink and still records the rest", () => {
  const { cwd, bares } = workspaceWithThree();
  const extra = initBareUpstream();
  // Declared but never synced: no gitlink in root HEAD, so it cannot be recorded.
  writeSources(
    cwd,
    sourcesFor([
      ...Object.entries(bares).map(([alias, bare]) => ({ alias, bare })),
      { alias: "extra", bare: extra },
    ]),
  );
  movePointer(cwd, "api");
  movePointer(cwd, "web");

  const result = run(["record", "--all"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output); // a skipped problem makes the run non-zero
  assert.match(output, /extra: the root HEAD has no recorded gitlink/);
  assert.match(output, /Summary: recorded 2, failed 1/);
  // The recordable aliases were still committed.
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): update submodules");
  const committed = gitOut(cwd, "show", "--name-only", "--pretty=format:", "HEAD");
  assert.match(committed, /oms\/api/);
  assert.match(committed, /oms\/web/);
});

test("record --all skips a pending removal and a staged pointer split", () => {
  const { cwd } = workspaceWithThree();
  movePointer(cwd, "api");
  // web: staged pointer, then moved again -> staged differs from the working tree.
  movePointer(cwd, "web");
  git(cwd, "add", "oms/web");
  movePointer(cwd, "web", "second");
  // core: pending removal (removal left unstaged by unsync).
  assert.equal(run(["unsync", "core"], { cwd }).status, 0);

  const result = run(["record", "--all"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /web: the staged oms\/web pointer differs from the working tree/);
  assert.match(output, /core: pending submodule removal/);
  // api was still recorded, and web's staged pointer was left in place.
  assert.match(gitOut(cwd, "log", "-1", "--pretty=%s"), /update api submodule/);
  assert.match(gitOut(cwd, "diff", "--cached", "--name-only"), /oms\/web/);
});

test("a named alias that cannot be recorded fails instead of being skipped", () => {
  const { cwd, bares } = workspaceWithThree();
  const extra = initBareUpstream();
  writeSources(
    cwd,
    sourcesFor([
      ...Object.entries(bares).map(([alias, bare]) => ({ alias, bare })),
      { alias: "extra", bare: extra },
    ]),
  );
  movePointer(cwd, "api");
  const before = gitOut(cwd, "rev-parse", "HEAD");

  // Naming the alias is an explicit request, so it is an error and nothing is recorded.
  const result = run(["record", "api", "extra"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /extra: the root HEAD has no recorded gitlink/);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), before);
});

test("a staged gitlink for a skipped alias is not an unrelated staged path", () => {
  const { cwd } = workspaceWithThree();
  movePointer(cwd, "api");
  // web is staged and split, so it is skipped -- but it is inside the selection, not unrelated.
  movePointer(cwd, "web");
  git(cwd, "add", "oms/web");
  movePointer(cwd, "web", "second");

  const result = run(["record", "--all"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.doesNotMatch(output, /unrelated staged changes/);
  // api recorded; web's staged pointer survived untouched.
  assert.match(gitOut(cwd, "log", "-1", "--pretty=%s"), /update api submodule/);
  assert.match(gitOut(cwd, "diff", "--cached", "--name-only"), /oms\/web/);
});

test("record fails for a staged path outside the selected alias set", () => {
  const { cwd } = workspaceWithThree();
  movePointer(cwd, "api");
  movePointer(cwd, "web");
  writeFileSync(join(cwd, "note.txt"), "x");
  git(cwd, "add", "note.txt");

  const result = run(["record", "api", "web"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /unrelated staged changes.*note\.txt/);
});

test("record aborts entirely when the root repository is in detached HEAD", () => {
  const { cwd } = workspaceWithThree();
  for (const alias of ["api", "web"]) movePointer(cwd, alias);
  const before = gitOut(cwd, "rev-parse", "HEAD");
  git(cwd, "checkout", "--detach");

  const result = run(["record", "--all"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /detached HEAD/);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), before); // no commit created
});

test("pull aggregates the record hint when it moves more than one pointer", () => {
  const { cwd, bares } = workspaceWithThree();
  // Advance two upstreams so pulling moves those two root pointers.
  for (const alias of ["api", "web"]) {
    const clone = tempFixture(`oms-up-${alias}-`);
    execFileSync("git", ["clone", bares[alias], clone], { stdio: "ignore", env: testEnv });
    configIdentity(clone);
    writeFileSync(join(clone, "upstream.txt"), "x");
    git(clone, "add", "-A");
    git(clone, "commit", "-m", "upstream work");
    git(clone, "push", "origin", "main");
  }

  const many = run(["pull", "--all"], { cwd });
  const manyOutput = many.stdout + many.stderr;
  assert.equal(many.status, 0, manyOutput);
  assert.match(manyOutput, /Run "oms record --all" to record 2 root pointer updates/);
  assert.doesNotMatch(manyOutput, /oms record api/);

  // A single moved pointer keeps the per-alias hint.
  assert.equal(run(["record", "--all"], { cwd }).status, 0);
  const clone = tempFixture("oms-up-core-");
  execFileSync("git", ["clone", bares.core, clone], { stdio: "ignore", env: testEnv });
  configIdentity(clone);
  writeFileSync(join(clone, "upstream.txt"), "x");
  git(clone, "add", "-A");
  git(clone, "commit", "-m", "upstream work");
  git(clone, "push", "origin", "main");

  const one = run(["pull", "--all"], { cwd });
  const oneOutput = one.stdout + one.stderr;
  assert.equal(one.status, 0, oneOutput);
  assert.match(oneOutput, /Run "oms record core" to record the root pointer update/);
  assert.doesNotMatch(oneOutput, /oms record --all/);
});

test("the record picker does not offer a staged-split pointer", () => {
  const { cwd } = workspaceWithThree();
  // A staged/worktree split reports pin "moved", so it must be excluded by the record verdict instead.
  movePointer(cwd, "api");
  git(cwd, "add", "oms/api");
  movePointer(cwd, "api", "second");

  // An empty queue makes the shell "interactive" without supplying a response: reaching a prompt would
  // fail closed as exhausted, so exit 0 proves no candidate was offered.
  const none = run(["record"], { cwd, env: queueEnv([]) });
  const noneOutput = none.stdout + none.stderr;
  assert.equal(none.status, 0, noneOutput);
  assert.match(noneOutput, /Nothing to record for any submodule/);

  // With a second, genuinely recordable alias, the split one is still not a candidate: the sole
  // candidate auto-selects instead of a two-item prompt (which the empty queue would fail closed on).
  movePointer(cwd, "web");
  const one = run(["record"], { cwd, env: queueEnv([]) });
  const oneOutput = one.stdout + one.stderr;
  assert.match(oneOutput, /Selected "web" \(the only moved pointer\)/);
  // The picker narrowed the selection to web, so api's staged gitlink is outside it and correctly
  // aborts the run -- the same rule as an explicit "oms record web" with oms/api staged.
  assert.equal(one.status, 1, oneOutput);
  assert.match(oneOutput, /unrelated staged changes.*oms\/api/);
});

test("record with an omitted selection resolves through the multi-select prompt", () => {
  const { cwd } = workspaceWithThree();
  for (const alias of ["api", "web", "core"]) movePointer(cwd, alias);

  // Two of the three moved pointers are chosen; core stays unrecorded.
  const result = run(["record"], {
    cwd,
    env: queueEnv([{ type: "multiselect", values: ["api", "web"] }]),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): update submodules");
  const committed = gitOut(cwd, "show", "--name-only", "--pretty=format:", "HEAD");
  assert.match(committed, /oms\/api/);
  assert.match(committed, /oms\/web/);
  assert.doesNotMatch(committed, /oms\/core/);
});

test("record rejects a staged/worktree pointer split", () => {
  const { cwd, wt } = workspaceWithApi();
  // Stage the gitlink at c1, then advance the submodule to c2 so index != worktree.
  writeFileSync(join(wt, "c1.txt"), "1");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "c1");
  git(cwd, "add", "oms/api");
  writeFileSync(join(wt, "c2.txt"), "2");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "c2");

  const result = run(["record", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /differs from the working tree/);
});

test("record rejects a missing recorded gitlink and points at topology commit", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0); // pending add: not recorded in HEAD

  const result = run(["record", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /only updates existing root gitlinks/);
  assert.match(output, /oms sync api --commit/);
});

test("record rejects a conflicted root gitlink", () => {
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
  assert.notEqual(merge.status, 0, "merge should conflict");

  const result = run(["record", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /conflict/i);
});

test("record rejects a pending removal and points at unsync", () => {
  const { cwd } = workspaceWithApi();
  // Remove the working tree path while the root HEAD still records the gitlink.
  rmSync(join(cwd, "oms", "api"), { recursive: true, force: true });

  const result = run(["record", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /pending submodule removal/);
  assert.match(output, /oms unsync api --commit/);
});

test("record rejects a detached root HEAD", () => {
  const { cwd } = workspaceWithMovedApi();
  git(cwd, "checkout", "--detach");

  const result = run(["record", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /detached HEAD/);
});

test("record rejects an in-progress root merge", () => {
  const { cwd } = workspaceWithApi();
  // A root-level merge conflict on a regular file.
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

  const result = run(["record", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /in progress/);
});

test("record leaves the gitlink staged when the root commit fails", () => {
  const { cwd } = workspaceWithMovedApi();
  // A failing pre-commit hook aborts the root commit after staging.
  const hook = join(cwd, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/usr/bin/env bash\nexit 1\n");
  execFileSync("chmod", ["+x", hook]);
  const hookEnv = { ...testEnv, GIT_CONFIG_COUNT: "5" };
  delete hookEnv.GIT_CONFIG_KEY_5;
  delete hookEnv.GIT_CONFIG_VALUE_5;

  const result = run(["record", "api"], { cwd, env: hookEnv });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /left in place/);
  // The selected gitlink remains staged for retry.
  assert.match(gitOut(cwd, "diff", "--cached", "--name-only"), /oms\/api/);
});


// --- multiple remotes ---

test("sync configures every declared remote on the submodule", () => {
  const origin = initBareUpstream();
  const upstream = initEmptyBare();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", origin, "main", { upstream }));

  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const remotes = gitOut(join(cwd, "oms", "api"), "remote").split("\n");
  assert.ok(remotes.includes("origin"), `origin missing: ${remotes}`);
  assert.ok(remotes.includes("upstream"), `upstream missing: ${remotes}`);
  assert.equal(
    gitOut(join(cwd, "oms", "api"), "remote", "get-url", "upstream"),
    `file://${upstream}`,
  );
});

test("re-syncing adds a remote declared after the initial sync", () => {
  const origin = initBareUpstream();
  const upstream = initEmptyBare();
  const cwd = initGitWorkspace();

  writeSources(cwd, sourceFor("api", origin));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  assert.ok(!gitOut(join(cwd, "oms", "api"), "remote").split("\n").includes("upstream"));

  writeSources(cwd, sourceFor("api", origin, "main", { upstream }));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  assert.ok(gitOut(join(cwd, "oms", "api"), "remote").split("\n").includes("upstream"));
});

test("push --remote targets the chosen remote and keeps origin as upstream", () => {
  const origin = initBareUpstream();
  const upstream = initEmptyBare();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", origin, "main", { upstream }));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  // Advance the submodule so the push has something to deliver.
  writeFileSync(join(cwd, "oms", "api", "feature.txt"), "x");
  git(join(cwd, "oms", "api"), "add", "-A");
  git(join(cwd, "oms", "api"), "commit", "-m", "feature");
  const head = gitOut(join(cwd, "oms", "api"), "rev-parse", "HEAD");

  const result = run(["push", "api", "--remote", "upstream"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);

  // upstream received main; origin did not, and main still tracks origin/main.
  assert.equal(gitOut(upstream, "rev-parse", "main"), head);
  assert.equal(
    gitOut(join(cwd, "oms", "api"), "rev-parse", "--abbrev-ref", "main@{u}"),
    "origin/main",
  );
});

test("fetch --remote accepts multiple remotes", () => {
  const origin = initBareUpstream();
  const upstream = initEmptyBare();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", origin, "main", { upstream }));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const result = run(["fetch", "api", "--remote", "origin", "--remote", "upstream"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /fetched \(origin, upstream\)/);
});

test("push --remote with an unknown remote fails for that repo", () => {
  const origin = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", origin));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const result = run(["push", "api", "--remote", "nope"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /unknown remote\(s\): nope/);
});

test("push --all pushes every declared repo and summarizes the result", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor([{ alias: "api", bare: a }, { alias: "web", bare: b }]));
  assert.equal(run(["sync", "--all"], { cwd }).status, 0);

  // Advance both submodules so each push has something to deliver.
  const heads = {};
  for (const alias of ["api", "web"]) {
    const wt = join(cwd, "oms", alias);
    writeFileSync(join(wt, "feature.txt"), "x");
    git(wt, "add", "-A");
    git(wt, "commit", "-m", "feature");
    heads[alias] = gitOut(wt, "rev-parse", "HEAD");
  }

  const result = run(["push", "--all"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Summary: pushed 2/);
  // Both upstreams received the new commit.
  assert.equal(gitOut(a, "rev-parse", "main"), heads.api);
  assert.equal(gitOut(b, "rev-parse", "main"), heads.web);
});

test("push with an omitted alias list resolves through the multi-select prompt", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor([{ alias: "api", bare: a }, { alias: "web", bare: b }]));
  assert.equal(run(["sync", "--all"], { cwd }).status, 0);

  const before = { api: gitOut(a, "rev-parse", "main"), web: gitOut(b, "rev-parse", "main") };
  const heads = {};
  for (const alias of ["api", "web"]) {
    const wt = join(cwd, "oms", alias);
    writeFileSync(join(wt, "feature.txt"), "x");
    git(wt, "add", "-A");
    git(wt, "commit", "-m", "feature");
    heads[alias] = gitOut(wt, "rev-parse", "HEAD");
  }

  // Only api is selected, so web's upstream must stay where it was.
  const result = run(["push"], { cwd, env: queueEnv([{ type: "multiselect", values: ["api"] }]) });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.equal(gitOut(a, "rev-parse", "main"), heads.api);
  assert.equal(gitOut(b, "rev-parse", "main"), before.web);
});

test("pull rejects more than one --remote", () => {
  const origin = initBareUpstream();
  const upstream = initEmptyBare();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", origin, "main", { upstream }));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const result = run(["pull", "api", "--remote", "origin", "--remote", "upstream"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /pull targets a single remote/);
});

test("an unknown remote fails only its repo and others still push", () => {
  const originA = initBareUpstream();
  const originB = initBareUpstream();
  const upstreamB = initEmptyBare();
  const cwd = initGitWorkspace();
  writeSources(
    cwd,
    `${sourceFor("a", originA).trimEnd()}\n  - alias: b\n    remotes:\n      origin: file://${originB}\n      upstream: file://${upstreamB}\n    branch: main\n`,
  );
  assert.equal(run(["sync", "--all"], { cwd }).status, 0);

  // Give b a commit so its upstream push delivers something.
  writeFileSync(join(cwd, "oms", "b", "f.txt"), "x");
  git(join(cwd, "oms", "b"), "add", "-A");
  git(join(cwd, "oms", "b"), "commit", "-m", "b feature");
  const headB = gitOut(join(cwd, "oms", "b"), "rev-parse", "HEAD");

  // a lacks "upstream" → a fails; b has it → b pushes.
  const result = run(["push", "a", "b", "--remote", "upstream"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /a: unknown remote\(s\): upstream/);
  assert.equal(gitOut(upstreamB, "rev-parse", "main"), headB);
});

test("oms.yaml without an origin remote is rejected", () => {
  const cwd = initGitWorkspace();
  writeSources(
    cwd,
    "repos:\n  - alias: api\n    remotes:\n      upstream: git@example.com:org/repo.git\n",
  );

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /must include an "origin" entry/);
});

test("legacy url key points to the 0.7.0 migration doc", () => {
  const cwd = initGitWorkspace();
  writeSources(
    cwd,
    "repos:\n  - alias: api\n    url: git@example.com:org/repo.git\n",
  );

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /url is no longer supported/);
  assert.match(
    output,
    /https:\/\/github\.com\/divlook\/oh-my-space\/blob\/[^/\s]+\/docs\/migrations\/0\.6\.x-to-0\.7\.0\.md/,
  );
});


// ─── sync metadata reconciliation (0.12.0) ───

test("sync reconciles drifted .gitmodules url and branch from the manifest, redacting URLs", () => {
  const bare = initBareUpstream({ branches: ["main", "develop"] });
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare, "main");
  // Drift both managed fields away from the manifest.
  git(cwd, "config", "--file", ".gitmodules", "submodule.oms/api.branch", "develop");
  git(cwd, "config", "--file", ".gitmodules", "submodule.oms/api.url", "https://drifted.example/x.git");

  const result = run(["sync", "api", "--commit"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /reconciled \.gitmodules/);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): reconcile api submodule metadata");
  // Managed fields are restored from the manifest (origin = file://<bare>) in the committed .gitmodules.
  const committed = gitOut(cwd, "show", "HEAD:.gitmodules");
  assert.match(committed, /branch = main/);
  assert.match(committed, new RegExp(`url = file://${bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  // No URL value is printed to the user.
  assert.doesNotMatch(output, /drifted\.example/);
  assert.doesNotMatch(output, new RegExp(bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("sync removes the .gitmodules branch key when the manifest omits branch", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare, "main"); // starts with branch = main
  assert.match(gitOut(cwd, "config", "--file", ".gitmodules", "--get", "submodule.oms/api.branch"), /main/);

  // Drop the branch key from the manifest; origin/HEAD resolves the baseline.
  writeFileSync(join(cwd, "oms.yaml"), `repos:\n  - alias: api\n    remotes:\n      origin: file://${bare}\n`);
  const result = run(["sync", "api", "--commit"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const committed = gitOut(cwd, "show", "HEAD:.gitmodules");
  assert.doesNotMatch(committed, /branch =/);
});

test("sync fails when the explicit manifest branch is absent on origin and does not change .gitmodules", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare, "main");
  writeFileSync(join(cwd, "oms.yaml"), `repos:\n  - alias: api\n    remotes:\n      origin: file://${bare}\n    branch: nope\n`);

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /not found on origin/);
  // .gitmodules baseline is unchanged.
  assert.match(gitOut(cwd, "config", "--file", ".gitmodules", "--get", "submodule.oms/api.branch"), /main/);
});

test("sync fails when an omitted baseline cannot resolve origin/HEAD", () => {
  // Point the remote default at a nonexistent branch so origin/HEAD is dangling (unresolvable), then
  // omit the manifest baseline: sync must fail closed instead of guessing a baseline.
  const bare = initBareUpstream({ branches: ["main", "develop"] });
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", bare, "main");
  writeFileSync(join(cwd, "oms.yaml"), `repos:\n  - alias: api\n    remotes:\n      origin: file://${bare}\n`);
  spawnSync("git", ["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/ghost"], { env: testEnv });
  spawnSync("git", ["-C", dir, "symbolic-ref", "-d", "refs/remotes/origin/HEAD"], { env: testEnv });

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /origin\/HEAD|declare "branch"/);
});

test("sync leaves reconciled metadata unstaged without a commit", () => {
  const bare = initBareUpstream({ branches: ["main", "develop"] });
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare, "main");
  git(cwd, "config", "--file", ".gitmodules", "submodule.oms/api.branch", "develop");
  const headBefore = gitOut(cwd, "rev-parse", "HEAD");

  const result = run(["sync", "api"], { cwd }); // no --commit, non-interactive
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // No new commit; the reconciled .gitmodules is a working-tree change, left unstaged.
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), headBefore);
  assert.match(gitOut(cwd, "config", "--file", ".gitmodules", "--get", "submodule.oms/api.branch"), /main/);
  assert.doesNotMatch(gitOut(cwd, "diff", "--cached", "--name-only"), /\.gitmodules/);
});

test("metadata reconciliation preserves the current working branch", () => {
  const bare = initBareUpstream({ branches: ["main", "develop"] });
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", bare, "main");
  assert.equal(run(["branch", "checkout", "api", "develop"], { cwd }).status, 0); // attach to develop
  assert.equal(gitOut(dir, "branch", "--show-current"), "develop");
  const recordedGitlink = gitOut(cwd, "rev-parse", "HEAD:oms/api");
  git(cwd, "config", "--file", ".gitmodules", "submodule.oms/api.url", "https://drift.example/x.git");

  assert.equal(run(["sync", "api", "--commit"], { cwd }).status, 0);
  // The submodule is still on develop; reconciliation never switches the working branch.
  assert.equal(gitOut(dir, "branch", "--show-current"), "develop");
  assert.equal(gitOut(cwd, "rev-parse", "HEAD:oms/api"), recordedGitlink);
});

test("sync finalizes new topology and existing metadata reconciliation in one commit", () => {
  const a = initBareUpstream({ branches: ["main", "develop"] });
  const b = initBareUpstream();
  const cwd = initGitWorkspace();
  // api is already synced; web is new. api's .gitmodules branch is drifted.
  syncedSubmodule(cwd, "api", a, "main");
  git(cwd, "config", "--file", ".gitmodules", "submodule.oms/api.branch", "develop");
  writeFileSync(
    cwd + "/oms.yaml",
    `repos:\n  - alias: api\n    remotes:\n      origin: file://${a}\n    branch: main\n  - alias: web\n    remotes:\n      origin: file://${b}\n    branch: main\n`,
  );

  const result = run(["sync", "api", "web", "--commit"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // One commit carries the new web topology and the reconciled api metadata together.
  const committed = gitOut(cwd, "show", "HEAD:.gitmodules");
  assert.match(committed, /submodule "oms\/web"/);
  assert.match(committed, /branch = main/); // api reconciled back to main
  assert.doesNotMatch(committed, /branch = develop/);
  const names = gitOut(cwd, "show", "--name-only", "--pretty=format:", "HEAD");
  assert.match(names, /oms\/web/);
});

test("sync restore reconciles .gitmodules metadata through the unified finalization", () => {
  const bare = initBareUpstream({ branches: ["main", "develop"] });
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare, "main");
  assert.equal(run(["unsync", "api"], { cwd }).status, 0); // pending removal, not committed
  // Change the manifest baseline to develop, then restore.
  writeFileSync(cwd + "/oms.yaml", `repos:\n  - alias: api\n    remotes:\n      origin: file://${bare}\n    branch: develop\n`);

  const result = run(["sync", "api", "--commit"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(join(cwd, "oms", "api")), true); // restored
  assert.match(gitOut(cwd, "show", "HEAD:.gitmodules"), /branch = develop/);
});

test("an interrupted commit after HEAD advances is recovered by the next command's preflight", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));

  // Crash immediately after HEAD advances but before the real index is installed.
  const crashed = run(["sync", "api", "--commit"], {
    cwd,
    env: { ...testEnv, OMS_TEST_MODE: "1", OMS_TEST_CRASH_AT: "after-head-advance" },
  });
  assert.notEqual(crashed.status, 0, crashed.stdout + crashed.stderr);
  // HEAD advanced to the commit; a committed recovery marker remains.
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), true);

  // The next root-mutating command completes the recovery and clears the state.
  const recovered = run(["sync", "api"], { cwd });
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), false);
  // The gitlink and .gitmodules are committed and clean.
  assert.doesNotMatch(gitOut(cwd, "status", "--porcelain"), /\.gitmodules|oms\/api/);
});

test("a malformed finalization marker blocks root-mutating commands", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare);
  mkdirSync(join(cwd, ".git", "oms"), { recursive: true });
  writeFileSync(join(cwd, ".git", "oms", "finalize.json"), "{ not valid");

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /malformed/i);
});

test("an orphaned finalization artifact without a marker blocks and is preserved", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare);
  mkdirSync(join(cwd, ".git", "oms"), { recursive: true });
  writeFileSync(join(cwd, ".git", "oms", "index.recovery"), "stale");

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /orphan/i);
  assert.equal(existsSync(join(cwd, ".git", "oms", "index.recovery")), true); // preserved
});

// ─── 7.8: durable finalization / recovery matrix ───

test("an interruption before HEAD advances preserves the real index and is cleaned on the next run", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));

  const headBefore = gitOut(cwd, "rev-parse", "HEAD");
  const crashed = run(["sync", "api", "--commit"], {
    cwd,
    env: { ...testEnv, OMS_TEST_MODE: "1", OMS_TEST_CRASH_AT: "after-marker-prepared" },
  });
  assert.notEqual(crashed.status, 0);
  // HEAD did not advance; only a prepared marker remains.
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), headBefore);
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), true);

  // The next run cleans the uncommitted prepared state and finalizes normally.
  const recovered = run(["sync", "api", "--commit"], { cwd });
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), false);
});

test("a committed recovery whose index no longer matches is preserved and blocks", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));

  const crashed = run(["sync", "api", "--commit"], {
    cwd,
    env: { ...testEnv, OMS_TEST_MODE: "1", OMS_TEST_CRASH_AT: "after-head-advance" },
  });
  assert.notEqual(crashed.status, 0);
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), true);

  // Change the real index so its hash no longer matches the recorded original.
  writeFileSync(join(cwd, "unrelated.txt"), "x");
  git(cwd, "add", "unrelated.txt");

  const blocked = run(["sync", "api"], { cwd });
  const output = blocked.stdout + blocked.stderr;
  assert.notEqual(blocked.status, 0, output);
  assert.match(output, /no longer matches|inspect/i);
  // The marker is preserved, not silently discarded.
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), true);
});

test("record completes a pending finalization recovery through the shared preflight", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));

  const crashed = run(["sync", "api", "--commit"], {
    cwd,
    env: { ...testEnv, OMS_TEST_MODE: "1", OMS_TEST_CRASH_AT: "after-head-advance" },
  });
  assert.notEqual(crashed.status, 0);
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), true);

  // record runs the same recovery preflight before touching the root pointer.
  const recovered = run(["record", "api"], { cwd });
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), false);
  assert.doesNotMatch(gitOut(cwd, "status", "--porcelain"), /\.gitmodules|oms\/api/);
});

test("every sync commit discloses and includes the complete working-tree oms.yaml", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));

  const result = run(["sync", "api", "--commit"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /complete working-tree oms\.yaml/i);
  // oms.yaml is part of the commit (it was untracked before).
  assert.match(gitOut(cwd, "show", "--name-only", "--pretty=format:", "HEAD"), /oms\.yaml/);
});

test("plain partial multi-alias sync does not prompt and leaves successful changes unstaged", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(
    cwd,
    `${sourceFor("api", a).trimEnd()}\n  - alias: web\n    remotes:\n      origin: file://${b}\n    branch: nope\n`,
  );

  // No --commit, non-interactive: web fails, api succeeds, nothing is committed or staged.
  const result = run(["sync", "api", "web"], { cwd });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.notEqual(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
});

test("a temporary-commit failure before HEAD advances preserves the real index byte-for-byte", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0); // topology left unstaged

  // Stage an unrelated path, capture the exact index bytes, then force a commit failure via a broken
  // commit identity so commit-tree fails before HEAD advances.
  writeFileSync(join(cwd, "keep.txt"), "x");
  git(cwd, "add", "keep.txt");
  const indexPath = join(cwd, ".git", "index");
  const before = readFileSync(indexPath);
  const headBefore = gitOut(cwd, "rev-parse", "HEAD");

  const result = run(["sync", "api", "--commit"], {
    cwd,
    env: { ...testEnv, OMS_TEST_MODE: "1", OMS_TEST_FAIL_AT: "commit-tree" },
  });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), headBefore);
  assert.deepEqual(readFileSync(indexPath), before);
});

test("an index-install failure after HEAD advances preserves recovery state for the next command", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));

  const failed = run(["sync", "api", "--commit"], {
    cwd,
    env: { ...testEnv, OMS_TEST_MODE: "1", OMS_TEST_FAIL_AT: "install-recovery-index" },
  });
  const output = failed.stdout + failed.stderr;
  assert.equal(failed.status, 2, output);
  assert.match(output, /commit .* was created.*recovery will retry/is);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), true);

  const recovered = run(["sync", "api"], { cwd });
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), false);
  assert.doesNotMatch(gitOut(cwd, "status", "--porcelain"), /\.gitmodules|oms\/api/);
});

test("an active finalization lock blocks a concurrent sync before shared state is changed", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  mkdirSync(join(cwd, ".git", "oms"), { recursive: true });
  const owner = `${process.pid}:test`;
  const blob = spawnSync("git", ["-C", cwd, "hash-object", "-w", "--stdin"], {
    input: owner,
    encoding: "utf8",
    env: testEnv,
  });
  assert.equal(blob.status, 0, blob.stderr);
  git(cwd, "update-ref", "refs/oms/finalize-lock", blob.stdout.trim());

  const result = run(["sync", "api", "--commit"], { cwd });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /finalization lock is held/);
  assert.equal(existsSync(join(cwd, "oms", "api")), false);
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), false);
  assert.equal(gitOut(cwd, "rev-parse", "refs/oms/finalize-lock"), blob.stdout.trim());

  git(cwd, "update-ref", "-d", "refs/oms/finalize-lock", blob.stdout.trim());
});

test("a crash after index installation is recognized as completed recovery", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));

  const crashed = run(["sync", "api", "--commit"], {
    cwd,
    env: { ...testEnv, OMS_TEST_MODE: "1", OMS_TEST_CRASH_AT: "after-index-install" },
  });
  assert.notEqual(crashed.status, 0, crashed.stdout + crashed.stderr);
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), true);

  const recovered = run(["sync", "api"], { cwd });
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), false);
  assert.doesNotMatch(gitOut(cwd, "status", "--porcelain"), /\.gitmodules|oms\/api/);
});

test("a crash after the real index rename cleans the retained recovery artifact", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));

  const crashed = run(["sync", "api", "--commit"], {
    cwd,
    env: { ...testEnv, OMS_TEST_MODE: "1", OMS_TEST_CRASH_AT: "after-index-rename" },
  });
  assert.notEqual(crashed.status, 0, crashed.stdout + crashed.stderr);
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), true);
  assert.equal(existsSync(join(cwd, ".git", "oms", "index.recovery")), true);

  const recovered = run(["sync", "api"], { cwd });
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), false);
  assert.equal(existsSync(join(cwd, ".git", "oms", "index.recovery")), false);
});

test("a dangling OMS state symlink blocks sync before topology mutation", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  symlinkSync(join(cwd, "missing-state-target"), join(cwd, ".git", "oms"));

  const result = run(["sync", "api", "--commit"], { cwd });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /unsafe OMS state directory/);
  assert.equal(existsSync(join(cwd, "oms", "api")), false);
});

test("a structurally incomplete finalization marker is rejected as malformed", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare);
  mkdirSync(join(cwd, ".git", "oms"), { recursive: true });
  writeFileSync(
    join(cwd, ".git", "oms", "finalize.json"),
    JSON.stringify({ state: "prepared", originalHead: gitOut(cwd, "rev-parse", "HEAD") }),
  );

  const result = run(["sync", "api"], { cwd });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /marker.*malformed/i);
});

test("unsync refuses an unmerged root .gitmodules before removing the submodule", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", bare);
  const content = readFileSync(join(cwd, ".gitmodules"), "utf8");
  const blob = spawnSync("git", ["-C", cwd, "hash-object", "-w", "--stdin"], {
    input: content,
    encoding: "utf8",
    env: testEnv,
  });
  assert.equal(blob.status, 0, blob.stderr);
  const oid = blob.stdout.trim();
  const conflict = spawnSync("git", ["-C", cwd, "update-index", "--index-info"], {
    input: [1, 2, 3].map((stage) => `100644 ${oid} ${stage}\t.gitmodules`).join("\n") + "\n",
    encoding: "utf8",
    env: testEnv,
  });
  assert.equal(conflict.status, 0, conflict.stderr);

  const result = run(["unsync", "api"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /\.gitmodules is unmerged/);
  assert.equal(existsSync(dir), true);
});

test("branch deletion fails closed when index baselines cannot be inspected", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", bare);
  git(dir, "branch", "feature/keep");

  const result = run(["branch", "delete", "api", "feature/keep"], {
    cwd,
    env: { ...testEnv, GIT_INDEX_FILE: cwd },
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /index \.gitmodules sources could not be listed/);
  assert.equal(localBranchExists(dir, "feature/keep"), true);
});
