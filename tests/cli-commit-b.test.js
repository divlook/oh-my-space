import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { testEnv, run, queueEnv, tempFixture, writeSources, git, configIdentity, initBareUpstream, initGitWorkspace, gitOut, initEmptyBare, sourceFor, workspaceWithApi, workspaceWithMovedApi, sourcesFor, syncedSubmodule } from "./helpers.js";
import { workspaceWithThree, movePointer } from "./cli-commit-fixtures.js";

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

test("commit without an alias resolves by candidate count, not by the terminal", () => {
  const clean = workspaceWithApi();
  const none = run(["commit", "-m", "x"], { cwd: clean.cwd });
  assert.equal(none.status, 0, none.stdout + none.stderr);
  assert.match(none.stdout + none.stderr, /Nothing to commit in any submodule/);

  const single = workspaceWithApi();
  writeFileSync(join(single.cwd, "oms", "api", "work.txt"), "x");
  const one = run(["commit", "-m", "feat: work"], { cwd: single.cwd });
  const oneOut = one.stdout + one.stderr;
  assert.equal(one.status, 0, oneOut);
  assert.match(oneOut, /Selected "api" \(the only dirty submodule\)/);
  assert.match(oneOut, /api: committed/);

  const a = initBareUpstream();
  const b = initBareUpstream();
  const many = initGitWorkspace();
  writeSources(many, sourcesFor([{ alias: "api", bare: a }, { alias: "web", bare: b }]));
  assert.equal(run(["sync", "--all"], { cwd: many }).status, 0);
  writeFileSync(join(many, "oms", "api", "f.txt"), "x");
  writeFileSync(join(many, "oms", "web", "f.txt"), "x");
  const two = run(["commit", "-m", "x"], { cwd: many });
  const twoOut = two.stdout + two.stderr;
  assert.equal(two.status, 1, twoOut);
  assert.match(twoOut, /not a TTY/);
  assert.match(twoOut, /api, web/);

  const queued = run(["commit", "-m", "feat: picked"], {
    cwd: many,
    env: queueEnv([{ type: "select", value: "web" }]),
  });
  const queuedOut = queued.stdout + queued.stderr;
  assert.equal(queued.status, 0, queuedOut);
  assert.match(queuedOut, /web: committed/);
  assert.equal(gitOut(join(many, "oms", "web"), "log", "-1", "--pretty=%s"), "feat: picked");
  assert.notEqual(gitOut(join(many, "oms", "api"), "log", "-1", "--pretty=%s"), "feat: picked");
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

test("record allows an already-staged selected gitlink that matches the working tree", () => {
  const { cwd } = workspaceWithMovedApi();
  git(cwd, "add", "oms/api");

  const result = run(["record", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(gitOut(cwd, "log", "-1", "--pretty=%s"), /update api submodule/);
});

test("record --all records every moved pointer and leaves unmoved ones alone", () => {
  const { cwd } = workspaceWithThree();
  movePointer(cwd, "web");

  const result = run(["record", "--all"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(gitOut(cwd, "log", "-1", "--pretty=%s"), /update web submodule/);
  const committed = gitOut(cwd, "show", "--name-only", "--pretty=format:", "HEAD");
  assert.match(committed, /oms\/web/);
  assert.doesNotMatch(committed, /oms\/(api|core)/);
});

test("record --all skips an alias with no recorded gitlink and still records the rest", () => {
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
  movePointer(cwd, "web");

  const result = run(["record", "--all"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /extra: the root HEAD has no recorded gitlink/);
  assert.match(output, /Summary: recorded 2, failed 1/);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): update submodules");
  const committed = gitOut(cwd, "show", "--name-only", "--pretty=format:", "HEAD");
  assert.match(committed, /oms\/api/);
  assert.match(committed, /oms\/web/);
});

test("a staged gitlink for a skipped alias is not an unrelated staged path", () => {
  const { cwd } = workspaceWithThree();
  movePointer(cwd, "api");
  movePointer(cwd, "web");
  git(cwd, "add", "oms/web");
  movePointer(cwd, "web", "second");

  const result = run(["record", "--all"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.doesNotMatch(output, /unrelated staged changes/);
  assert.match(gitOut(cwd, "log", "-1", "--pretty=%s"), /update api submodule/);
  assert.match(gitOut(cwd, "diff", "--cached", "--name-only"), /oms\/web/);
});

test("pull aggregates the record hint when it moves more than one pointer", () => {
  const { cwd, bares } = workspaceWithThree();
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

test("record rejects a staged/worktree pointer split", () => {
  const { cwd, wt } = workspaceWithApi();
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

test("record rejects a pending removal and points at unsync", () => {
  const { cwd } = workspaceWithApi();
  rmSync(join(cwd, "oms", "api"), { recursive: true, force: true });

  const result = run(["record", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /pending submodule removal/);
  assert.match(output, /oms unsync api --commit/);
});

test("record leaves the gitlink staged when the root commit fails", () => {
  const { cwd } = workspaceWithMovedApi();
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
  assert.match(gitOut(cwd, "diff", "--cached", "--name-only"), /oms\/api/);
});

test("push --remote targets the chosen remote and keeps origin as upstream", () => {
  const origin = initBareUpstream();
  const upstream = initEmptyBare();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", origin, "main", { upstream }));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  writeFileSync(join(cwd, "oms", "api", "feature.txt"), "x");
  git(join(cwd, "oms", "api"), "add", "-A");
  git(join(cwd, "oms", "api"), "commit", "-m", "feature");
  const head = gitOut(join(cwd, "oms", "api"), "rev-parse", "HEAD");

  const result = run(["push", "api", "--remote", "upstream"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);

  assert.equal(gitOut(upstream, "rev-parse", "main"), head);
  assert.equal(
    gitOut(join(cwd, "oms", "api"), "rev-parse", "--abbrev-ref", "main@{u}"),
    "origin/main",
  );
});

test("push --all pushes every declared repo and summarizes the result", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor([{ alias: "api", bare: a }, { alias: "web", bare: b }]));
  assert.equal(run(["sync", "--all"], { cwd }).status, 0);

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
  assert.equal(gitOut(a, "rev-parse", "main"), heads.api);
  assert.equal(gitOut(b, "rev-parse", "main"), heads.web);
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

  writeFileSync(join(cwd, "oms", "b", "f.txt"), "x");
  git(join(cwd, "oms", "b"), "add", "-A");
  git(join(cwd, "oms", "b"), "commit", "-m", "b feature");
  const headB = gitOut(join(cwd, "oms", "b"), "rev-parse", "HEAD");

  const result = run(["push", "a", "b", "--remote", "upstream"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /a: unknown remote\(s\): upstream/);
  assert.equal(gitOut(upstreamB, "rev-parse", "main"), headB);
});

test("sync reconciles drifted .gitmodules url and branch from the manifest, redacting URLs", () => {
  const bare = initBareUpstream({ branches: ["main", "develop"] });
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare, "main");
  git(cwd, "config", "--file", ".gitmodules", "submodule.oms/api.branch", "develop");
  git(cwd, "config", "--file", ".gitmodules", "submodule.oms/api.url", "https://drifted.example/x.git");

  const result = run(["sync", "api", "--commit"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /reconciled \.gitmodules/);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): reconcile api submodule metadata");
  const committed = gitOut(cwd, "show", "HEAD:.gitmodules");
  assert.match(committed, /branch = main/);
  assert.match(committed, new RegExp(`url = file://${bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.doesNotMatch(output, /drifted\.example/);
  assert.doesNotMatch(output, new RegExp(bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("sync fails when an omitted baseline cannot resolve origin/HEAD", () => {
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

test("sync finalizes new topology and existing metadata reconciliation in one commit", () => {
  const a = initBareUpstream({ branches: ["main", "develop"] });
  const b = initBareUpstream();
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", a, "main");
  git(cwd, "config", "--file", ".gitmodules", "submodule.oms/api.branch", "develop");
  writeFileSync(
    cwd + "/oms.yaml",
    `repos:\n  - alias: api\n    remotes:\n      origin: file://${a}\n    branch: main\n  - alias: web\n    remotes:\n      origin: file://${b}\n    branch: main\n`,
  );

  const result = run(["sync", "api", "web", "--commit"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const committed = gitOut(cwd, "show", "HEAD:.gitmodules");
  assert.match(committed, /submodule "oms\/web"/);
  assert.match(committed, /branch = main/);
  assert.doesNotMatch(committed, /branch = develop/);
  const names = gitOut(cwd, "show", "--name-only", "--pretty=format:", "HEAD");
  assert.match(names, /oms\/web/);
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

  writeFileSync(join(cwd, "unrelated.txt"), "x");
  git(cwd, "add", "unrelated.txt");

  const blocked = run(["sync", "api"], { cwd });
  const output = blocked.stdout + blocked.stderr;
  assert.notEqual(blocked.status, 0, output);
  assert.match(output, /no longer matches|inspect/i);
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), true);
});

test("plain partial multi-alias sync commits the successful alias and still exits non-zero", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(
    cwd,
    `${sourceFor("api", a).trimEnd()}\n  - alias: web\n    remotes:\n      origin: file://${b}\n    branch: nope\n`,
  );

  const result = run(["sync", "api", "web"], { cwd });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
  assert.doesNotMatch(readFileSync(join(cwd, ".gitmodules"), "utf8"), /oms\/web/);
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
