import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { testEnv, run, queueEnv, writeSources, git, initBareUpstream, initGitWorkspace, gitOut, initEmptyBare, sourceFor, workspaceWithMovedApi, sourcesFor, syncedSubmodule } from "./helpers.js";
import { workspaceWithThree, movePointer } from "./cli-commit-fixtures.js";

test("commit gives an explicit alias precedence over the current submodule context", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(
    cwd,
    `repos:\n  - alias: api\n    remotes:\n      origin: file://${bare}\n    branch: main\n  - alias: web\n    remotes:\n      origin: file://${bare}\n    branch: main\n`,
  );
  assert.equal(run(["sync", "api", "web", "--no-commit"], { cwd }).status, 0);
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

test("record commits only the moved gitlink with a conventional message", () => {
  const { cwd, wt } = workspaceWithMovedApi();
  const sha = gitOut(wt, "rev-parse", "--short", "HEAD");

  const result = run(["record", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), `chore(oms): update api submodule to ${sha}`);
  assert.match(output, new RegExp(`chore\\(oms\\): update api submodule to ${sha}`));
  assert.equal(gitOut(cwd, "show", "--name-only", "--pretty=format:", "HEAD").trim(), "oms/api");
  assert.equal(gitOut(cwd, "status", "--porcelain"), "");
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

test("record rejects a staged gitlink for a different alias", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor([{ alias: "api", bare: a }, { alias: "web", bare: b }]));
  assert.equal(run(["sync", "--all", "--no-commit"], { cwd }).status, 0);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add submodules");
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

test("record without a selection resolves by candidate count, not by the terminal", () => {
  const moveOne = (cwd, alias) => {
    writeFileSync(join(cwd, "oms", alias, "f.txt"), "x");
    git(join(cwd, "oms", alias), "add", "-A");
    git(join(cwd, "oms", alias), "commit", "-m", "work");
  };

  const none = workspaceWithThree();
  const zero = run(["record"], { cwd: none.cwd });
  assert.equal(zero.status, 0, zero.stdout + zero.stderr);
  assert.match(zero.stdout + zero.stderr, /Nothing to record for any submodule/);

  const single = workspaceWithThree();
  moveOne(single.cwd, "api");
  const one = run(["record"], { cwd: single.cwd });
  const oneOut = one.stdout + one.stderr;
  assert.equal(one.status, 0, oneOut);
  assert.match(oneOut, /Selected "api" \(the only moved pointer\)/);
  assert.equal(gitOut(single.cwd, "log", "-1", "--pretty=%s").startsWith("chore(oms): update api"), true);

  const many = workspaceWithThree();
  moveOne(many.cwd, "api");
  moveOne(many.cwd, "web");
  const two = run(["record"], { cwd: many.cwd });
  const twoOut = two.stdout + two.stderr;
  assert.equal(two.status, 1, twoOut);
  assert.match(twoOut, /not a TTY/);
  assert.match(twoOut, /api, web/);
  assert.match(twoOut, /--all/);
});

test("record --all skips a pending removal and a staged pointer split", () => {
  const { cwd } = workspaceWithThree();
  movePointer(cwd, "api");
  movePointer(cwd, "web");
  git(cwd, "add", "oms/web");
  movePointer(cwd, "web", "second");
  assert.equal(run(["unsync", "core", "--no-commit"], { cwd }).status, 0);

  const result = run(["record", "--all"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /web: the staged oms\/web pointer differs from the working tree/);
  assert.match(output, /core: pending submodule removal/);
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

test("the record picker does not offer a staged-split pointer", () => {
  const { cwd } = workspaceWithThree();
  movePointer(cwd, "api");
  git(cwd, "add", "oms/api");
  movePointer(cwd, "api", "second");

  // An empty queue makes the shell "interactive" without supplying a response: reaching a prompt would
  // fail closed as exhausted, so exit 0 proves no candidate was offered.
  const none = run(["record"], { cwd, env: queueEnv([]) });
  const noneOutput = none.stdout + none.stderr;
  assert.equal(none.status, 0, noneOutput);
  assert.match(noneOutput, /Nothing to record for any submodule/);

  movePointer(cwd, "web");
  const one = run(["record"], { cwd, env: queueEnv([]) });
  const oneOutput = one.stdout + one.stderr;
  assert.match(oneOutput, /Selected "web" \(the only moved pointer\)/);
  assert.equal(one.status, 1, oneOutput);
  assert.match(oneOutput, /unrelated staged changes.*oms\/api/);
});

test("record rejects a missing recorded gitlink and points at topology commit", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api", "--no-commit"], { cwd }).status, 0);

  const result = run(["record", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /only updates existing root gitlinks/);
  assert.match(output, /oms sync api --commit/);
});

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

  const result = run(["push"], { cwd, env: queueEnv([{ type: "multiselect", values: ["api"] }]) });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.equal(gitOut(a, "rev-parse", "main"), heads.api);
  assert.equal(gitOut(b, "rev-parse", "main"), before.web);
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

test("sync removes the .gitmodules branch key when the manifest omits branch", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare, "main");
  assert.match(gitOut(cwd, "config", "--file", ".gitmodules", "--get", "submodule.oms/api.branch"), /main/);

  writeFileSync(join(cwd, "oms.yaml"), `repos:\n  - alias: api\n    remotes:\n      origin: file://${bare}\n`);
  const result = run(["sync", "api", "--commit"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const committed = gitOut(cwd, "show", "HEAD:.gitmodules");
  assert.doesNotMatch(committed, /branch =/);
});

test("sync leaves reconciled metadata unstaged without a commit", () => {
  const bare = initBareUpstream({ branches: ["main", "develop"] });
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare, "main");
  git(cwd, "config", "--file", ".gitmodules", "submodule.oms/api.branch", "develop");
  const headBefore = gitOut(cwd, "rev-parse", "HEAD");

  const result = run(["sync", "api", "--no-commit"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), headBefore);
  assert.match(gitOut(cwd, "config", "--file", ".gitmodules", "--get", "submodule.oms/api.branch"), /main/);
  assert.doesNotMatch(gitOut(cwd, "diff", "--cached", "--name-only"), /\.gitmodules/);
});

test("sync restore reconciles .gitmodules metadata through the unified finalization", () => {
  const bare = initBareUpstream({ branches: ["main", "develop"] });
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare, "main");
  // The removal must stay uncommitted, or the root gitlink disappears from HEAD and the next sync
  // takes the fresh-add path instead of restorePendingRemoval — silently voiding this test's subject.
  assert.equal(run(["unsync", "api", "--no-commit"], { cwd }).status, 0);
  writeFileSync(cwd + "/oms.yaml", `repos:\n  - alias: api\n    remotes:\n      origin: file://${bare}\n    branch: develop\n`);

  const result = run(["sync", "api", "--commit"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(join(cwd, "oms", "api")), true);
  assert.match(gitOut(cwd, "show", "HEAD:.gitmodules"), /branch = develop/);
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
  assert.equal(existsSync(join(cwd, ".git", "oms", "index.recovery")), true);
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

  const recovered = run(["record", "api"], { cwd });
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), false);
  assert.doesNotMatch(gitOut(cwd, "status", "--porcelain"), /\.gitmodules|oms\/api/);
});

test("a temporary-commit failure before HEAD advances preserves the real index byte-for-byte", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api", "--no-commit"], { cwd }).status, 0);

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
