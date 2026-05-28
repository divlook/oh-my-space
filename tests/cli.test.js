import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const cli = resolve("dist/oms.js");

const testEnv = {
  ...process.env,
  // Allow file-protocol submodule clones (git 2.38+ blocks file:// in submodules by default).
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

function writeSources(cwd, content = "repos:\n  - alias: sample\n    url: git@example.com:org/repo.git\n    branch: main\n") {
  writeFileSync(join(cwd, "sources.yaml"), content);
}

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function configIdentity(cwd) {
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
}

function initBareRepoWithMain() {
  const bare = mkdtempSync(join(tmpdir(), "oms-source-"));
  execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "ignore" });
  const seed = mkdtempSync(join(tmpdir(), "oms-seed-"));
  execFileSync("git", ["init", "-b", "main", seed], { stdio: "ignore" });
  configIdentity(seed);
  git(seed, "commit", "--allow-empty", "-m", "init");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "-u", "origin", "main");
  return bare;
}

function initGitWorkspace() {
  const cwd = tempWorkspace();
  execFileSync("git", ["init", "-b", "main", cwd], { stdio: "ignore" });
  configIdentity(cwd);
  git(cwd, "commit", "--allow-empty", "-m", "init");
  return cwd;
}

test("help is exposed as oms without removed workspace asset commands", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: oms/);
  assert.match(result.stdout, /sync/);
  assert.doesNotMatch(result.stdout, /\binit\b/);
  assert.doesNotMatch(result.stdout, /\bmigrate\b/);
  assert.doesNotMatch(result.stdout, /OpenSpec/i);
  assert.doesNotMatch(result.stdout, /template/i);
  assert.doesNotMatch(result.stdout, /bun run oms/);
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
  assert.match(output, /Create a sources\.yaml/);
});

test("invalid sources.yaml fails before git operations", () => {
  const cwd = tempWorkspace();
  writeSources(cwd, "repos:\n  - alias: Invalid_Alias\n    url: git@example.com:org/repo.git\n");

  const result = run(["sync", "sample"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1);
  assert.match(output, /must match/);
  assert.equal(existsSync(join(cwd, "sources", "sample")), false);
  assert.equal(existsSync(join(cwd, ".git", "modules", "sample")), false);
});

test("doctor checks sources.yaml and git without OpenSpec", () => {
  const cwd = tempWorkspace();
  writeSources(cwd);

  const result = run(["doctor"], { cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Workspace root:/);
  assert.match(result.stdout, /sources\.yaml: 1 repo\(s\) configured/);
  assert.match(result.stdout, /git:/);
  assert.doesNotMatch(result.stdout + result.stderr, /OpenSpec|openspec/);
});

test("help exposes the unsync command", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\bunsync\b/);
});

test("unsync --help describes the staged-changes side effect", () => {
  const result = run(["unsync", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /staged changes/i);
  assert.match(result.stdout, /commit/i);
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

test("sync rejects a missing branch via preflight and leaves no .git/modules debris", () => {
  const bare = initBareRepoWithMain();
  const cwd = initGitWorkspace();
  writeSources(
    cwd,
    `repos:\n  - alias: probe\n    url: file://${bare}\n    branch: nonexistent\n`,
  );

  const result = run(["sync", "probe"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /branch "nonexistent" not found/);
  assert.equal(existsSync(join(cwd, ".git", "modules", "probe")), false);
  assert.equal(existsSync(join(cwd, "sources", "probe")), false);
});

test("sync + unsync round-trip preserves sources.yaml and allows re-sync", () => {
  const bare = initBareRepoWithMain();
  const cwd = initGitWorkspace();
  writeSources(
    cwd,
    `repos:\n  - alias: probe\n    url: file://${bare}\n    branch: main\n`,
  );

  const synced = run(["sync", "probe"], { cwd });
  assert.equal(synced.status, 0, synced.stdout + synced.stderr);
  assert.ok(existsSync(join(cwd, "sources", "probe")));
  assert.ok(existsSync(join(cwd, ".git", "modules", "probe")));

  const unsynced = run(["unsync", "probe"], { cwd });
  const unsyncOutput = unsynced.stdout + unsynced.stderr;
  assert.equal(unsynced.status, 0, unsyncOutput);
  assert.match(unsyncOutput, /unsynced/);
  assert.equal(existsSync(join(cwd, "sources", "probe")), false);
  assert.equal(existsSync(join(cwd, ".git", "modules", "probe")), false);

  const yaml = readFileSync(join(cwd, "sources.yaml"), "utf8");
  assert.match(yaml, /alias: probe/);

  const resynced = run(["sync", "probe"], { cwd });
  assert.equal(resynced.status, 0, resynced.stdout + resynced.stderr);
  assert.ok(existsSync(join(cwd, "sources", "probe")));
});
