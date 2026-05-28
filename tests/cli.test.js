import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const cli = resolve("dist/oms.js");

const testEnv = {
  ...process.env,
  // Allow file-protocol clones (git 2.38+ blocks file:// by default in some flows).
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "protocol.file.allow",
  GIT_CONFIG_VALUE_0: "always",
};

function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: testEnv,
    ...options,
  });
}

function tempWorkspace() {
  return mkdtempSync(join(tmpdir(), "oms-test-"));
}

function writeSources(cwd, content) {
  writeFileSync(
    join(cwd, "sources.yaml"),
    content
      ?? "repos:\n  - alias: sample\n    url: git@example.com:org/repo.git\n    branch: main\n",
  );
}

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function configIdentity(cwd) {
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
}

/**
 * Create a bare upstream + a seed repo that pushes branches into it.
 * Returns the bare repo path. Optionally creates additional branches.
 */
function initBareUpstream({ branches = ["main"] } = {}) {
  const bare = mkdtempSync(join(tmpdir(), "oms-source-"));
  execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "ignore" });
  const seed = mkdtempSync(join(tmpdir(), "oms-seed-"));
  execFileSync("git", ["init", "-b", "main", seed], { stdio: "ignore" });
  configIdentity(seed);
  git(seed, "commit", "--allow-empty", "-m", "init");
  for (const b of branches) {
    if (b === "main") continue;
    git(seed, "checkout", "-b", b);
    git(seed, "commit", "--allow-empty", "-m", `init-${b}`);
  }
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "--all", "origin");
  return bare;
}

function initGitWorkspace() {
  const cwd = tempWorkspace();
  execFileSync("git", ["init", "-b", "main", cwd], { stdio: "ignore" });
  configIdentity(cwd);
  git(cwd, "commit", "--allow-empty", "-m", "init");
  return cwd;
}

function gitOut(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("help is exposed as oms with new commands", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: oms/);
  assert.match(result.stdout, /sync/);
  assert.match(result.stdout, /\bunsync\b/);
  assert.match(result.stdout, /\bworktree\b/);
  assert.doesNotMatch(result.stdout, /\bmigrate\b/);
});

test("sync --list loads sources.yaml from a parent workspace", () => {
  const cwd = tempWorkspace();
  mkdirSync(join(cwd, "nested"));
  writeSources(cwd);

  const result = run(["sync", "--list"], { cwd: join(cwd, "nested") });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /sample/);
  assert.match(result.stdout, /git@example.com:org\/repo.git/);
  assert.match(result.stdout, /main/);
});

test("missing sources.yaml fails with creation guidance", () => {
  const cwd = tempWorkspace();
  const result = run(["sync", "--list"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1);
  assert.match(output, /Could not find sources\.yaml/);
});

test("invalid sources.yaml fails before any disk side effects", () => {
  const cwd = tempWorkspace();
  writeSources(
    cwd,
    "repos:\n  - alias: Invalid_Alias\n    url: git@example.com:org/repo.git\n",
  );

  const result = run(["sync", "sample"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1);
  assert.match(output, /must match/);
  assert.equal(existsSync(join(cwd, "sources")), false);
});

test("doctor reports workspace, sources count, git version, and gitignore warning", () => {
  const cwd = tempWorkspace();
  writeSources(cwd);
  const result = run(["doctor"], { cwd });
  const output = result.stdout + result.stderr;
  // doctor returns 2 when warnings exist (missing .gitignore is a warning)
  assert.ok(result.status === 0 || result.status === 2, output);
  assert.match(output, /Workspace root:/);
  assert.match(output, /sources\.yaml: 1 repo\(s\) configured/);
  assert.match(output, /git:/);
  assert.match(output, /\.gitignore does not exclude sources\//);
});

test("unsync rejects an unknown alias", () => {
  const cwd = tempWorkspace();
  writeSources(cwd);
  const result = run(["unsync", "missing"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /Unknown alias/);
});

test("unsync on a never-synced alias reports nothing to remove with exit 0", () => {
  const cwd = tempWorkspace();
  writeSources(cwd);
  const result = run(["unsync", "sample"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /nothing to remove/i);
});

test("sync creates .bare, .git placeholder, baseline worktree, and adds gitignore", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(
    cwd,
    `repos:\n  - alias: probe\n    url: file://${bare}\n    branch: main\n`,
  );

  const result = run(["sync", "probe"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);

  assert.ok(existsSync(join(cwd, "sources", "probe", ".bare")));
  assert.ok(existsSync(join(cwd, "sources", "probe", ".git")));
  assert.equal(
    readFileSync(join(cwd, "sources", "probe", ".git"), "utf8"),
    "gitdir: ./.bare\n",
  );
  assert.ok(existsSync(join(cwd, "sources", "probe", "main")));

  // gitignore was created and includes sources/
  const gi = readFileSync(join(cwd, ".gitignore"), "utf8");
  assert.match(gi, /^sources\/$/m);

  // fetch refspec is set in the bare clone
  const refspec = gitOut(
    join(cwd, "sources", "probe", ".bare"),
    "-c",
    "safe.bareRepository=all",
    "config",
    "--get",
    "remote.origin.fetch",
  );
  assert.equal(refspec, "+refs/heads/*:refs/remotes/origin/*");

  // baseline worktree has the branch checked out (not detached) with upstream
  const branch = gitOut(join(cwd, "sources", "probe", "main"), "branch", "--show-current");
  assert.equal(branch, "main");
  const upstream = gitOut(
    join(cwd, "sources", "probe", "main"),
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  );
  assert.equal(upstream, "origin/main");
});

test("sync rejects a missing branch via preflight and leaves no debris", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(
    cwd,
    `repos:\n  - alias: probe\n    url: file://${bare}\n    branch: nonexistent\n`,
  );

  const result = run(["sync", "probe"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /branch "nonexistent" not found/);
  assert.equal(existsSync(join(cwd, "sources", "probe")), false);
});

test("worktree add creates a worktree for a non-default branch with slash", () => {
  const bare = initBareUpstream({ branches: ["main", "dev", "feature/foo"] });
  const cwd = initGitWorkspace();
  writeSources(
    cwd,
    `repos:\n  - alias: api\n    url: file://${bare}\n    branch: main\n`,
  );

  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const add = run(["worktree", "add", "api", "feature/foo"], { cwd });
  assert.equal(add.status, 0, add.stdout + add.stderr);
  assert.ok(existsSync(join(cwd, "sources", "api", "feature", "foo")));

  const branch = gitOut(
    join(cwd, "sources", "api", "feature", "foo"),
    "branch",
    "--show-current",
  );
  assert.equal(branch, "feature/foo");

  const list = run(["worktree", "list", "api"], { cwd });
  assert.equal(list.status, 0);
  assert.match(list.stdout, /feature\/foo/);
  assert.match(list.stdout, /main/);
});

test("worktree add refuses if the branch path already exists", () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = initGitWorkspace();
  writeSources(cwd, `repos:\n  - alias: api\n    url: file://${bare}\n    branch: main\n`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  assert.equal(run(["worktree", "add", "api", "dev"], { cwd }).status, 0);
  const second = run(["worktree", "add", "api", "dev"], { cwd });
  const output = second.stdout + second.stderr;
  assert.equal(second.status, 1, output);
  assert.match(output, /already exists/);
});

test("worktree remove refuses to discard uncommitted changes", () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = initGitWorkspace();
  writeSources(cwd, `repos:\n  - alias: api\n    url: file://${bare}\n    branch: main\n`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  assert.equal(run(["worktree", "add", "api", "dev"], { cwd }).status, 0);

  writeFileSync(join(cwd, "sources", "api", "dev", "dirty.txt"), "x");
  const blocked = run(["worktree", "remove", "api", "dev"], { cwd });
  const output = blocked.stdout + blocked.stderr;
  assert.equal(blocked.status, 2, output);
  assert.match(output, /uncommitted changes/);
  assert.ok(existsSync(join(cwd, "sources", "api", "dev")));

  const forced = run(["worktree", "remove", "api", "dev", "--force"], { cwd });
  assert.equal(forced.status, 0, forced.stdout + forced.stderr);
  assert.equal(existsSync(join(cwd, "sources", "api", "dev")), false);
});

test("worktree remove cleans up empty parent directories for slash branches", () => {
  const bare = initBareUpstream({ branches: ["main", "feature/foo"] });
  const cwd = initGitWorkspace();
  writeSources(cwd, `repos:\n  - alias: api\n    url: file://${bare}\n    branch: main\n`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  assert.equal(run(["worktree", "add", "api", "feature/foo"], { cwd }).status, 0);

  assert.equal(run(["worktree", "remove", "api", "feature/foo"], { cwd }).status, 0);
  assert.equal(existsSync(join(cwd, "sources", "api", "feature", "foo")), false);
  assert.equal(existsSync(join(cwd, "sources", "api", "feature")), false);
  assert.ok(existsSync(join(cwd, "sources", "api", "main")));
});

test("fetch updates origin refs in the bare clone", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, `repos:\n  - alias: api\n    url: file://${bare}\n    branch: main\n`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  // Add a new commit to upstream
  const seedClone = mkdtempSync(join(tmpdir(), "oms-pushtest-"));
  execFileSync("git", ["clone", bare, seedClone], { stdio: "ignore", env: testEnv });
  configIdentity(seedClone);
  git(seedClone, "commit", "--allow-empty", "-m", "upstream-new");
  execFileSync("git", ["push", "origin", "main"], { cwd: seedClone, stdio: "ignore", env: testEnv });

  const result = run(["fetch", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /fetched/);
});

test("push delivers new worktree commits to the bare upstream", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, `repos:\n  - alias: api\n    url: file://${bare}\n    branch: main\n`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const wt = join(cwd, "sources", "api", "main");
  configIdentity(wt);
  writeFileSync(join(wt, "new-file.txt"), "hello");
  git(wt, "add", "new-file.txt");
  git(wt, "commit", "-m", "add new-file");
  const localSha = gitOut(wt, "rev-parse", "HEAD");

  const result = run(["push", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /pushed/);

  const upstreamSha = execFileSync(
    "git",
    ["-c", "safe.bareRepository=all", "-C", bare, "rev-parse", "refs/heads/main"],
    { encoding: "utf8" },
  ).trim();
  assert.equal(upstreamSha, localSha);
});

test("push fails clearly when the baseline worktree has no upstream", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, `repos:\n  - alias: api\n    url: file://${bare}\n    branch: main\n`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  // Strip the upstream that oms sync set up.
  execFileSync(
    "git",
    [
      "-C",
      join(cwd, "sources", "api", "main"),
      "branch",
      "--unset-upstream",
      "main",
    ],
    { stdio: "ignore" },
  );

  const result = run(["push", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /requires an upstream/);
});

test("pull --ff-only succeeds on the baseline worktree", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, `repos:\n  - alias: api\n    url: file://${bare}\n    branch: main\n`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const result = run(["pull", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /pulled/);
});

test("sync + worktree round-trip preserves sources.yaml and allows re-sync", () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = initGitWorkspace();
  writeSources(cwd, `repos:\n  - alias: api\n    url: file://${bare}\n    branch: main\n`);

  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  assert.equal(run(["worktree", "add", "api", "dev"], { cwd }).status, 0);

  const unsynced = run(["unsync", "api"], { cwd });
  assert.equal(unsynced.status, 0, unsynced.stdout + unsynced.stderr);
  assert.equal(existsSync(join(cwd, "sources", "api")), false);
  const yaml = readFileSync(join(cwd, "sources.yaml"), "utf8");
  assert.match(yaml, /alias: api/);

  const resynced = run(["sync", "api"], { cwd });
  assert.equal(resynced.status, 0, resynced.stdout + resynced.stderr);
  assert.ok(existsSync(join(cwd, "sources", "api", ".bare")));
  assert.ok(existsSync(join(cwd, "sources", "api", "main")));
});

test("legacy .gitmodules with registered sources/<alias> blocks sync with migration hint", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd, "repos:\n  - alias: api\n    url: git@example.com:org/api.git\n    branch: main\n");
  // Hand-craft .gitmodules + commit a gitlink-like dummy to satisfy the registration check.
  writeFileSync(
    join(cwd, ".gitmodules"),
    "[submodule \"api\"]\n\tpath = sources/api\n\turl = git@example.com:org/api.git\n",
  );

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /legacy submodule layout/);
  assert.match(output, /Migrating from 0\.2\.x/);
});

test("doctor reports remote.origin.fetch present after sync and no warnings", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, `repos:\n  - alias: api\n    url: file://${bare}\n    branch: main\n`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const result = run(["doctor"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /bare clone OK/);
  assert.match(output, /refspec: \+refs\/heads\/\*:refs\/remotes\/origin\/\*/);
});

test("doctor warns when remote.origin.fetch is missing and suggests a fix", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, `repos:\n  - alias: api\n    url: file://${bare}\n    branch: main\n`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  // Unset the refspec to simulate the broken state.
  execFileSync(
    "git",
    [
      "-C",
      join(cwd, "sources", "api", ".bare"),
      "-c",
      "safe.bareRepository=all",
      "config",
      "--unset",
      "remote.origin.fetch",
    ],
    { stdio: "ignore" },
  );

  const result = run(["doctor"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /missing remote\.origin\.fetch/);
});
