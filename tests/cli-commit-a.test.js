import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { testEnv, run, queueEnv, tempFixture, writeSources, git, configIdentity, initBareUpstream, initGitWorkspace, gitOut, initEmptyBare, sourceFor, workspaceWithApi, workspaceWithMovedApi, sourcesFor, syncedSubmodule } from "./helpers.js";
import { workspaceWithThree, movePointer } from "./cli-commit-fixtures.js";

test("commit rejects an unanchored detached submodule HEAD without touching the root", () => {
  const { cwd } = workspaceWithApi();
  const wt = join(cwd, "oms", "api");
  git(wt, "commit", "--allow-empty", "-m", "detached tip");
  git(wt, "checkout", "--detach");
  git(wt, "branch", "-f", "main", "HEAD^");
  const rootHeadBefore = gitOut(cwd, "rev-parse", "HEAD");

  const result = run(["commit", "api", "-m", "x"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /detached HEAD/);
  assert.match(output, /oms branch switch api/);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootHeadBefore);
});

test("commit infers the alias and initializes it before evaluating preconditions", () => {
  const { cwd } = workspaceWithApi();
  const clone = tempFixture("oms-clone-");
  execFileSync("git", ["clone", cwd, clone], { stdio: "ignore", env: testEnv });
  configIdentity(clone);
  assert.equal(existsSync(join(clone, "oms", "api", ".git")), false);
  const rootHeadBefore = gitOut(clone, "rev-parse", "HEAD");

  const result = run(["commit", "-m", "x"], { cwd: join(clone, "oms", "api") });
  const output = result.stdout + result.stderr;

  assert.equal(result.status, 0, output);
  assert.match(output, /initializing registered submodule/);
  assert.match(output, /Nothing to commit for api/);
  assert.equal(existsSync(join(clone, "oms", "api", ".git")), true);
  assert.equal(gitOut(clone, "rev-parse", "HEAD"), rootHeadBefore);
  assert.equal(gitOut(clone, "diff", "--cached", "--name-only"), "");
});

test("record is a no-op without pointer movement and does not warn for dirty source", () => {
  const { cwd } = workspaceWithApi();
  writeFileSync(join(cwd, "oms", "api", "dirty.txt"), "x");
  const rootHeadBefore = gitOut(cwd, "rev-parse", "HEAD");

  const result = run(["record", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Nothing to record for api/);
  assert.doesNotMatch(output, /uncommitted source/);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootHeadBefore);
});

test("record allows unrelated unstaged root changes and stays path-limited", () => {
  const { cwd } = workspaceWithMovedApi();
  writeFileSync(join(cwd, "root.txt"), "x");

  const result = run(["record", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(cwd, "show", "--name-only", "--pretty=format:", "HEAD").trim(), "oms/api");
  assert.match(gitOut(cwd, "status", "--porcelain"), /root\.txt/);
});

test("record with several aliases creates one plural root commit", () => {
  const { cwd } = workspaceWithThree();
  for (const alias of ["api", "web", "core"]) movePointer(cwd, alias);

  const result = run(["record", "api", "web", "core"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): update submodules");
  const committed = gitOut(cwd, "show", "--name-only", "--pretty=format:", "HEAD");
  for (const alias of ["api", "web", "core"]) assert.match(committed, new RegExp(`oms/${alias}`));
  assert.equal(gitOut(cwd, "rev-list", "--count", "HEAD"), "3");
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

  const result = run(["record", "api", "extra"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /extra: the root HEAD has no recorded gitlink/);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), before);
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
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), before);
});

test("record with an omitted selection resolves through the multi-select prompt", () => {
  const { cwd } = workspaceWithThree();
  for (const alias of ["api", "web", "core"]) movePointer(cwd, alias);

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

test("record rejects an in-progress root merge", () => {
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

  const result = run(["record", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /in progress/);
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

test("sync fails when the explicit manifest branch is absent on origin and does not change .gitmodules", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare, "main");
  writeFileSync(join(cwd, "oms.yaml"), `repos:\n  - alias: api\n    remotes:\n      origin: file://${bare}\n    branch: nope\n`);

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /not found on origin/);
  assert.match(gitOut(cwd, "config", "--file", ".gitmodules", "--get", "submodule.oms/api.branch"), /main/);
});

test("metadata reconciliation preserves the current working branch", () => {
  const bare = initBareUpstream({ branches: ["main", "develop"] });
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", bare, "main");
  assert.equal(run(["branch", "checkout", "api", "develop"], { cwd }).status, 0);
  assert.equal(gitOut(dir, "branch", "--show-current"), "develop");
  const recordedGitlink = gitOut(cwd, "rev-parse", "HEAD:oms/api");
  git(cwd, "config", "--file", ".gitmodules", "submodule.oms/api.url", "https://drift.example/x.git");

  assert.equal(run(["sync", "api", "--commit"], { cwd }).status, 0);
  assert.equal(gitOut(dir, "branch", "--show-current"), "develop");
  assert.equal(gitOut(cwd, "rev-parse", "HEAD:oms/api"), recordedGitlink);
});

test("an interrupted commit after HEAD advances is recovered by the next command's preflight", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));

  const crashed = run(["sync", "api", "--commit"], {
    cwd,
    env: { ...testEnv, OMS_TEST_MODE: "1", OMS_TEST_CRASH_AT: "after-head-advance" },
  });
  assert.notEqual(crashed.status, 0, crashed.stdout + crashed.stderr);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), true);

  const recovered = run(["sync", "api"], { cwd });
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), false);
  assert.doesNotMatch(gitOut(cwd, "status", "--porcelain"), /\.gitmodules|oms\/api/);
});

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
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), headBefore);
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), true);

  const recovered = run(["sync", "api", "--commit"], { cwd });
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), false);
});

test("every sync commit discloses and includes the complete working-tree oms.yaml", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));

  const result = run(["sync", "api", "--commit"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /complete working-tree oms\.yaml/i);
  assert.match(gitOut(cwd, "show", "--name-only", "--pretty=format:", "HEAD"), /oms\.yaml/);
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
