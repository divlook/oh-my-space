import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { testEnv, run, queueEnv, tempFixture, writeSources, git, configIdentity, initBareUpstream, initGitWorkspace, gitOut, sourceFor, workspaceWithApi, statusJson, workspaceCloneWithDriftedBaseline, sourcesFor } from "./helpers.js";

// chmod 0o000 is not enforced for root, so permission-denial cases cannot run there.
const skipUnreadable =
  typeof process.getuid === "function" && process.getuid() === 0
    ? { skip: "chmod 0o000 is not enforced when running as root" }
    : {};

test("sync registers a submodule on its baseline branch and tracks it in the parent", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("probe", bare));

  const result = run(["sync", "probe"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);

  const modules = readFileSync(join(cwd, ".gitmodules"), "utf8");
  assert.match(modules, /path = oms\/probe/);
  assert.match(modules, /branch = main/);
  assert.equal(gitOut(join(cwd, "oms", "probe"), "branch", "--show-current"), "main");

  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add probe submodule");
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
  assert.equal(gitOut(cwd, "status", "--porcelain"), "");
  const committed = gitOut(cwd, "show", "--name-only", "--pretty=format:", "HEAD");
  assert.match(committed, /\.gitmodules/);
  assert.match(committed, /oms\/probe/);

  if (existsSync(join(cwd, ".gitignore"))) {
    assert.doesNotMatch(readFileSync(join(cwd, ".gitignore"), "utf8"), /^oms\/$/m);
  }
});

test("switch creates a brand-new local branch without any remote precondition", () => {
  const { cwd } = workspaceWithApi();

  const sw = run(["branch", "switch", "api", "feature/new"], { cwd });
  const output = sw.stdout + sw.stderr;
  assert.equal(sw.status, 0, output);
  assert.match(output, /created new local branch/);
  assert.equal(gitOut(join(cwd, "oms", "api"), "branch", "--show-current"), "feature/new");

  const upstreamCheck = spawnSync(
    "git",
    ["-C", join(cwd, "oms", "api"), "rev-parse", "--abbrev-ref", "feature/new@{u}"],
    { encoding: "utf8", env: testEnv },
  );
  assert.notEqual(upstreamCheck.status, 0);
});

test("checkout refuses a branch absent on origin and points at switch", () => {
  const { cwd } = workspaceWithApi();

  const co = run(["branch", "checkout", "api", "feature/new"], { cwd });
  const output = co.stdout + co.stderr;
  assert.equal(co.status, 1, output);
  assert.match(output, /not found on origin/);
  assert.match(output, /oms branch switch api feature\/new/);
});

test("push --commit is unsupported and fails before pushing", () => {
  const { bare, cwd } = workspaceWithApi();

  const wt = join(cwd, "oms", "api");
  writeFileSync(join(wt, "f.txt"), "x");
  git(wt, "add", "f.txt");
  git(wt, "commit", "-m", "work");
  const localSha = gitOut(wt, "rev-parse", "HEAD");
  const rootHeadBefore = gitOut(cwd, "rev-parse", "HEAD");

  const result = run(["push", "api", "--commit"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /not supported/);
  assert.match(output, /oms record api/);
  assert.notEqual(gitOut(bare, "rev-parse", "main"), localSha);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootHeadBefore);
});

test("fetch updates origin refs inside the submodule", () => {
  const { cwd } = workspaceWithApi();

  const result = run(["fetch", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /fetched/);
});

test("status --json represents a detached submodule HEAD explicitly", () => {
  const { cwd } = workspaceWithApi();
  git(join(cwd, "oms", "api"), "checkout", "--detach");
  const repo = statusJson(cwd).repos[0];
  assert.equal(repo.branch, null);
  assert.equal(repo.detached, true);
  assert.match(repo.head, /^[0-9a-f]+$/);
});

test("status --json narrows repos and pointer arrays to the selected aliases", () => {
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

  const data = statusJson(cwd, ["api"]);
  assert.equal(data.repos.length, 1);
  assert.equal(data.repos[0].alias, "api");
  assert.deepEqual(data.root.submodulePointers.moved, ["api"]);
  assert.ok(data.root.branch);
  assert.equal(data.currentAlias, null);
});

test("status --json keeps valid JSON and exits non-zero when a repo read fails", () => {
  const { cwd } = workspaceWithApi();
  rmSync(join(cwd, ".git", "modules", "oms", "api"), { recursive: true, force: true });

  const result = run(["status", "--json"], { cwd });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  const data = JSON.parse(result.stdout);
  const repo = data.repos[0];
  assert.equal(typeof repo.error, "string");
  assert.equal(repo.head, null);
  assert.deepEqual(repo.changes, { staged: 0, unstaged: 0, untracked: 0 });
  assert.equal(data.errors.length, 1);
});

test("unsync commits the removal topology by default", () => {
  const { cwd } = workspaceWithApi();
  const before = Number(gitOut(cwd, "rev-list", "--count", "HEAD"));

  assert.equal(run(["unsync", "api"], { cwd }).status, 0);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): remove api submodule");
  assert.equal(Number(gitOut(cwd, "rev-list", "--count", "HEAD")), before + 1);
  assert.equal(gitOut(cwd, "status", "--porcelain"), "");
  assert.match(readFileSync(join(cwd, "oms.yaml"), "utf8"), /alias: api/);
});

test("delegated preparation sync commits its topology", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));

  const result = run(["branch", "list", "api"], {
    cwd,
    env: queueEnv([{ type: "select", value: "sync" }]),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
  assert.equal(gitOut(cwd, "status", "--porcelain"), "");
});

test("omitted selection fails with an actionable message in a non-interactive shell", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor([{ alias: "api", bare: a }, { alias: "web", bare: b }]));
  assert.equal(run(["sync", "--all"], { cwd }).status, 0);

  for (const command of ["sync", "fetch", "pull", "unsync", "push"]) {
    const result = run([command], { cwd });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 1, `${command}: ${output}`);
    assert.match(output, /not a TTY/, command);
    assert.match(output, new RegExp(`oms ${command} --all`), command);
  }
});

test("multi-alias sync --commit finalizes the successful alias and excludes the failed one", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(
    cwd,
    `${sourceFor("api", a).trimEnd()}\n  - alias: web\n    remotes:\n      origin: file://${b}\n    branch: nope\n`,
  );

  const result = run(["sync", "api", "web", "--commit"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
  const committed = gitOut(cwd, "show", "--name-only", "--pretty=format:", "HEAD");
  assert.match(committed, /oms\/api/);
  assert.doesNotMatch(committed, /oms\/web/);
});

test("unsync --commit rejects partial removal topology it cannot complete", () => {
  const { cwd, wt } = workspaceWithApi();
  git(cwd, "config", "--file", ".gitmodules", "--remove-section", "submodule.oms/api");
  writeFileSync(join(wt, "dirty.txt"), "x");

  const result = run(["unsync", "api", "--commit"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /partial removal topology/i);
});

test("sync restore preserves .gitmodules section order for a clean multi-alias restore", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const c = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor([{ alias: "api", bare: a }, { alias: "web", bare: b }, { alias: "docs", bare: c }]));
  assert.equal(run(["sync", "--all", "--no-commit"], { cwd }).status, 0);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add submodules");

  // Both removals stay uncommitted so the restores below are real restores, not fresh adds.
  assert.equal(run(["unsync", "api", "--no-commit"], { cwd }).status, 0);
  assert.equal(run(["unsync", "web", "--no-commit"], { cwd }).status, 0);
  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /restored pending removal/);
  assert.equal(run(["sync", "web"], { cwd }).status, 0);

  const sections = [...readFileSync(join(cwd, ".gitmodules"), "utf8")
    .matchAll(/^\[submodule "oms\/([^"]+)"\]/gm)].map((m) => m[1]);
  assert.deepEqual(sections, ["api", "web", "docs"]);
  assert.equal(gitOut(cwd, "status", "--porcelain"), "");
});

test("sync restore fails before add when a non-submodule path occupies the alias", () => {
  const { cwd } = workspaceWithApi();
  assert.equal(run(["unsync", "api", "--no-commit"], { cwd }).status, 0);
  mkdirSync(join(cwd, "oms", "api"), { recursive: true });
  writeFileSync(join(cwd, "oms", "api", "file.txt"), "not a submodule");

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /cannot restore pending removal safely/);
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

test("unsync refuses when oms/<alias> is unreadable", skipUnreadable, () => {
  const { cwd } = workspaceWithApi();
  assert.equal(run(["unsync", "api"], { cwd }).status, 0);
  mkdirSync(join(cwd, "oms", "api"), { recursive: true });
  chmodSync(join(cwd, "oms", "api"), 0o000);
  try {
    const result = run(["unsync", "api"], { cwd });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 2, output);
    assert.match(output, /could not be read \(permission or I\/O error\)/);
    assert.doesNotMatch(output, /occupied by a non-submodule/);
    assert.doesNotMatch(output, /api: unsynced/);
  } finally {
    chmodSync(join(cwd, "oms", "api"), 0o755);
  }
});

test("unsync refuses before deinit/rm during an in-progress root operation", () => {
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

  const result = run(["unsync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /in progress/);
  assert.doesNotMatch(output, /uncommitted or untracked changes/);
  assert.equal(existsSync(join(cwd, "oms", "api", ".git")), true);
});

test("pull rejects a dirty submodule before running", () => {
  const { cwd, wt } = workspaceWithApi();
  writeFileSync(join(wt, "dirty.txt"), "x");

  const result = run(["pull", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /uncommitted changes/);
});

test("push warns about a dirty submodule but still pushes the current HEAD", () => {
  const { cwd, wt } = workspaceWithApi();
  writeFileSync(join(wt, "committed.txt"), "x");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "work");
  writeFileSync(join(wt, "dirty.txt"), "y");

  const result = run(["push", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /only the current HEAD will be pushed/);
  assert.match(output, /pushed/);
});



test("unsync removes the submodule, keeps oms.yaml, and re-sync works", () => {
  const { cwd } = workspaceWithApi();

  const unsynced = run(["unsync", "api"], { cwd });
  assert.equal(unsynced.status, 0, unsynced.stdout + unsynced.stderr);
  assert.equal(existsSync(join(cwd, "oms", "api")), false);
  if (existsSync(join(cwd, ".gitmodules"))) {
    assert.doesNotMatch(readFileSync(join(cwd, ".gitmodules"), "utf8"), /oms\/api/);
  }
  assert.match(readFileSync(join(cwd, "oms.yaml"), "utf8"), /alias: api/);

  assert.equal(gitOut(cwd, "status", "--porcelain"), "");

  const resynced = run(["sync", "api"], { cwd });
  assert.equal(resynced.status, 0, resynced.stdout + resynced.stderr);
  assert.ok(existsSync(join(cwd, "oms", "api", ".git")));
  assert.equal(gitOut(join(cwd, "oms", "api"), "branch", "--show-current"), "main");
});

test("a committed pointer reproduces on a fresh clone via sync", () => {
  const { cwd } = workspaceWithApi();
  const pin = gitOut(cwd, "rev-parse", `:oms/api`);

  const clone = tempFixture("oms-clone-");
  execFileSync("git", ["clone", cwd, clone], { stdio: "ignore", env: testEnv });
  configIdentity(clone);
  assert.equal(existsSync(join(clone, "oms", "api", ".git")), false);

  const result = run(["sync", "api"], { cwd: clone });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.equal(gitOut(join(clone, "oms", "api"), "rev-parse", "HEAD"), pin);
  assert.equal(gitOut(join(clone, "oms", "api"), "branch", "--show-current"), "main");
  assert.match(output, /api: initialized \(branch=main\)/);
});

test("sync relabels detached HEAD when the baseline points at the same commit", () => {
  const { cwd, wt } = workspaceWithApi();
  const head = gitOut(wt, "rev-parse", "HEAD");
  git(wt, "checkout", "--detach");

  const result = run(["sync", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(wt, "branch", "--show-current"), "main");
  assert.equal(gitOut(wt, "rev-parse", "HEAD"), head);
});

test("sync restore preserves the recorded pointer when its retained baseline diverged", () => {
  const { alias, cwd, pin, wt } = workspaceCloneWithDriftedBaseline();
  git(cwd, "submodule", "update", "--init", "--", `oms/${alias}`);
  assert.equal(run(["unsync", alias, "--no-commit"], { cwd }).status, 0);

  const result = run(["sync", alias], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /restored pending removal/);
  assert.match(output, /kept detached HEAD at [0-9a-f]{7} because baseline "main"/);
  assert.equal(gitOut(wt, "rev-parse", "HEAD"), pin);
  assert.equal(gitOut(wt, "branch", "--show-current"), "");
});
