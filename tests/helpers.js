import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
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
import assert from "node:assert/strict";
import semver from "semver";
import { normalizedTestEnvironment } from "../scripts/verification/environment.mjs";

const workerRoot = mkdtempSync(join(tmpdir(), "oms-tests-"));
const retainFixtures = process.env.OMS_TEST_RETAIN_FIXTURES === "1";

function copyFixture(template, prefix) {
  const destination = tempFixture(prefix);
  rmSync(destination, { recursive: true });
  cpSync(template, destination, { recursive: true });
  return destination;
}

function tempFixture(prefix) {
  return mkdtempSync(join(workerRoot, prefix));
}

process.on("exit", () => {
  if (retainFixtures) {
    process.stderr.write("Fixtures retained at " + workerRoot + "\n");
    return;
  }
  rmSync(workerRoot, { recursive: true, force: true });
});

const cli = resolve("dist/oms.js");
const publishBetaScript = resolve("scripts/publish-beta.mjs");

const testEnv = normalizedTestEnvironment({
  NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE ?? resolve("node_modules/.cache/oms-test-compile", process.version),
});

function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: testEnv,
    ...options,
  });
}

// Read the version under test so release bumps do not invalidate these fixtures.
const currentVersion = JSON.parse(readFileSync(resolve("package.json"), "utf8")).version;
// A registry latest strictly newer than the installed version.
const newerVersion = semver.inc(currentVersion, "patch");

// Escapes dots so embedded version strings match literally.
function versionPattern(text) {
  return new RegExp(text.replaceAll(".", "\\."));
}

function updateEnv(overrides = {}) {
  return {
    ...testEnv,
    OMS_TEST_MODE: "1",
    OMS_TEST_REGISTRY_RESPONSE: JSON.stringify({ "dist-tags": { latest: newerVersion } }),
    ...overrides,
  };
}

function queueEnv(responses, overrides = {}) {
  return {
    ...testEnv,
    OMS_TEST_MODE: "1",
    OMS_TEST_PROMPT_RESPONSES: JSON.stringify(responses),
    ...overrides,
  };
}

function installContext(kind, extra = {}) {
  return JSON.stringify({
    kind,
    label: `${kind} test install`,
    guidance: [`guidance for ${kind}`],
    warnings: [],
    ...extra,
  });
}

function tempWorkspace() {
  return tempFixture("oms-test-");
}

function writeSources(cwd, content) {
  writeFileSync(
    join(cwd, "oms.yaml"),
    content
      ?? "repos:\n  - alias: sample\n    remotes:\n      origin: git@example.com:org/repo.git\n    branch: main\n",
  );
}

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "ignore", env: testEnv });
}

function configIdentity(cwd) {
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
}

let upstreamTemplate = process.env.OMS_TEST_UPSTREAM_TEMPLATE;
let workspaceTemplate = process.env.OMS_TEST_WORKSPACE_TEMPLATE;
let apiWorkspaceTemplate = process.env.OMS_TEST_API_WORKSPACE_TEMPLATE;

function getUpstreamTemplate() {
  if (upstreamTemplate) return upstreamTemplate;

  upstreamTemplate = tempFixture("oms-upstream-template-");
  execFileSync("git", ["init", "--bare", "-b", "main", upstreamTemplate], {
    stdio: "ignore",
    env: testEnv,
  });
  const seed = tempFixture("oms-template-seed-");
  execFileSync("git", ["init", "-b", "main", seed], { stdio: "ignore", env: testEnv });
  configIdentity(seed);
  git(seed, "commit", "--allow-empty", "-m", "init");
  git(seed, "remote", "add", "origin", upstreamTemplate);
  git(seed, "push", "origin", "main");
  return upstreamTemplate;
}

function getWorkspaceTemplate() {
  if (workspaceTemplate) return workspaceTemplate;

  workspaceTemplate = tempFixture("oms-workspace-template-");
  execFileSync("git", ["init", "-b", "main", workspaceTemplate], {
    stdio: "ignore",
    env: testEnv,
  });
  configIdentity(workspaceTemplate);
  git(workspaceTemplate, "commit", "--allow-empty", "-m", "init");
  return workspaceTemplate;
}

function getApiWorkspaceTemplate() {
  if (apiWorkspaceTemplate) return apiWorkspaceTemplate;

  apiWorkspaceTemplate = initGitWorkspace();
  writeSources(apiWorkspaceTemplate, sourceFor("api", getUpstreamTemplate()));
  // --no-commit pins the fixture's shape: the topology commit is hand-authored below so this template
  // keeps its own subject and commit count. Tests that assert on sync's own commit create their own
  // workspace; a shared fixture must not change shape when sync's default does.
  assert.equal(run(["sync", "api", "--no-commit"], { cwd: apiWorkspaceTemplate }).status, 0);
  git(apiWorkspaceTemplate, "add", "-A");
  git(apiWorkspaceTemplate, "commit", "-m", "add api submodule");
  return apiWorkspaceTemplate;
}

/** Build immutable fixture templates once for reuse by parallel test owners. */
function prepareSharedFixtures() {
  return {
    upstream: getUpstreamTemplate(),
    workspace: getWorkspaceTemplate(),
    apiWorkspace: getApiWorkspaceTemplate(),
  };
}

/**
 * Create a bare upstream + a seed repo that pushes branches into it.
 * Returns the bare repo path. Optionally creates additional branches.
 */
function initBareUpstream({ branches = ["main"] } = {}) {
  const bare = copyFixture(getUpstreamTemplate(), "oms-source-");
  for (const b of branches) {
    if (b === "main") continue;
    git(bare, "branch", b, "main");
  }
  return bare;
}

/** A git workspace (parent repo) with an initial commit — the host for submodules. */
function initGitWorkspace() {
  return copyFixture(getWorkspaceTemplate(), "oms-test-");
}

function gitOut(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: testEnv }).trim();
}

/** An empty bare repo — a valid push target that shares no history with the seeded origin. */
function initEmptyBare() {
  const bare = tempFixture("oms-source-");
  execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "ignore", env: testEnv });
  return bare;
}

function sourceFor(alias, bare, branch = "main", extraRemotes = {}) {
  const remoteLines = [`      origin: file://${bare}`];
  for (const [name, url] of Object.entries(extraRemotes)) {
    remoteLines.push(`      ${name}: file://${url}`);
  }
  return `repos:\n  - alias: ${alias}\n    remotes:\n${remoteLines.join("\n")}\n    branch: ${branch}\n`;
}

function gitTopLevelStubEnv(mode) {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const stubDir = tempFixture("oms-git-stub-");
  const stubGit = join(stubDir, "git");
  const response = mode === "failure"
    ? 'echo "simulated top-level inspection failure" >&2; exit 2'
    : mode === "localized-no-work-tree"
      ? 'if [ "$LC_ALL" = "C" ]; then echo "fatal: not a git repository" >&2; else echo "localized diagnostic" >&2; fi; exit 128'
      : 'echo "/path/that/does/not/exist"; exit 0';
  writeFileSync(
    stubGit,
    `#!/usr/bin/env bash\nif [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then ${response}; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
  );
  chmodSync(stubGit, 0o755);
  return { ...testEnv, PATH: `${stubDir}:${process.env.PATH}` };
}

/** A workspace with `api` synced and its initial gitlink recorded in the root HEAD. */
function workspaceWithApi() {
  const bare = initBareUpstream();
  const cwd = copyFixture(getApiWorkspaceTemplate(), "oms-test-");
  writeSources(cwd, sourceFor("api", bare));
  git(cwd, "config", "-f", ".gitmodules", "submodule.oms/api.url", `file://${bare}`);
  const wt = join(cwd, "oms", "api");
  git(wt, "remote", "set-url", "origin", `file://${bare}`);
  git(wt, "checkout", "-B", "main", "origin/main");
  git(cwd, "add", "oms.yaml", ".gitmodules");
  git(cwd, "commit", "--amend", "--no-edit");
  return { cwd, bare, wt };
}

/** Parse the JSON object a `status --json` run wrote to stdout, asserting a clean exit. */
function statusJson(cwd, args = [], expectStatus = 0) {
  const result = run(["status", "--json", ...args], { cwd });
  assert.equal(result.status, expectStatus, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}

/** A workspace with `api` recorded, then advanced by one submodule commit (pointer moved, unrecorded). */
function workspaceWithMovedApi() {
  const { cwd, bare } = workspaceWithApi();
  const wt = join(cwd, "oms", "api");
  writeFileSync(join(wt, "f.txt"), "x");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "work");
  return { cwd, bare, wt };
}
/** A fresh root clone pinned at A while the configured baseline has advanced to B. */
function workspaceCloneWithDriftedBaseline(alias = "api") {
  const bare = initBareUpstream();
  const source = initGitWorkspace();
  syncedSubmodule(source, alias, bare);
  const pin = gitOut(source, "rev-parse", `:oms/${alias}`);

  const scratch = tempFixture("oms-drift-source-");
  execFileSync("git", ["clone", bare, scratch], { stdio: "ignore", env: testEnv });
  configIdentity(scratch);
  writeFileSync(join(scratch, "advanced.txt"), "baseline advanced\n");
  git(scratch, "add", "advanced.txt");
  git(scratch, "commit", "-m", "advance baseline");
  git(scratch, "push", "origin", "main");
  const tip = gitOut(scratch, "rev-parse", "HEAD");

  const cwd = tempFixture("oms-drift-clone-");
  execFileSync("git", ["clone", source, cwd], { stdio: "ignore", env: testEnv });
  configIdentity(cwd);
  return { alias, bare, cwd, pin, tip, wt: join(cwd, "oms", alias) };
}

/** A multi-repo oms.yaml mapping each alias to its own bare origin. */
function sourcesFor(entries) {
  const body = entries
    .map(({ alias, bare }) => `  - alias: ${alias}\n    remotes:\n      origin: file://${bare}\n    branch: main`)
    .join("\n");
  return `repos:\n${body}\n`;
}

/** Count submodule.*.path entries remaining in .gitmodules (0 when the file is gone). */
function gitmodulesSectionCount(cwd) {
  const path = join(cwd, ".gitmodules");
  if (!existsSync(path)) return 0;
  const r = spawnSync("git", ["config", "--file", path, "--get-regexp", "^submodule\\..*\\.path$"], {
    encoding: "utf8",
    env: testEnv,
  });
  if (r.status !== 0) return 0;
  return r.stdout.split("\n").filter((l) => l.trim().length > 0).length;
}

function syncedSubmodule(cwd, alias, bare, branch = "main") {
  writeSources(cwd, sourceFor(alias, bare, branch));
  const path = join("oms", alias);
  git(cwd, "submodule", "add", "-b", branch, `file://${bare}`, path);
  git(cwd, "add", "oms.yaml", ".gitmodules", path);
  git(cwd, "commit", "-m", `chore(oms): add ${alias} submodule`);
  return join(cwd, path);
}

function localBranchExists(dir, branch) {
  return spawnSync("git", ["-C", dir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
    env: testEnv,
  }).status === 0;
}

export {
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
  prepareSharedFixtures,
  initBareUpstream,
  initGitWorkspace,
  gitOut,
  initEmptyBare,
  sourceFor,
  gitTopLevelStubEnv,
  workspaceWithApi,
  statusJson,
  workspaceWithMovedApi,
  workspaceCloneWithDriftedBaseline,
  sourcesFor,
  gitmodulesSectionCount,
  syncedSubmodule,
  localBranchExists,
};
