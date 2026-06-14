import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import semver from "semver";

const cli = resolve("dist/oms.js");

const testEnv = {
  ...process.env,
  // Allow file-protocol clones, keep test commits unsigned, and provide a commit
  // identity so commits succeed even on hosts (CI) without a global git identity.
  // These are process-scoped (GIT_CONFIG_*), never written to disk.
  GIT_CONFIG_COUNT: "4",
  GIT_CONFIG_KEY_0: "protocol.file.allow",
  GIT_CONFIG_VALUE_0: "always",
  GIT_CONFIG_KEY_1: "commit.gpgsign",
  GIT_CONFIG_VALUE_1: "false",
  GIT_CONFIG_KEY_2: "user.email",
  GIT_CONFIG_VALUE_2: "test@example.com",
  GIT_CONFIG_KEY_3: "user.name",
  GIT_CONFIG_VALUE_3: "Test",
};

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
  return mkdtempSync(join(tmpdir(), "oms-test-"));
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

/**
 * Create a bare upstream + a seed repo that pushes branches into it.
 * Returns the bare repo path. Optionally creates additional branches.
 */
function initBareUpstream({ branches = ["main"] } = {}) {
  const bare = mkdtempSync(join(tmpdir(), "oms-source-"));
  execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "ignore", env: testEnv });
  const seed = mkdtempSync(join(tmpdir(), "oms-seed-"));
  execFileSync("git", ["init", "-b", "main", seed], { stdio: "ignore", env: testEnv });
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

/** A git workspace (parent repo) with an initial commit — the host for submodules. */
function initGitWorkspace() {
  const cwd = tempWorkspace();
  execFileSync("git", ["init", "-b", "main", cwd], { stdio: "ignore", env: testEnv });
  configIdentity(cwd);
  git(cwd, "commit", "--allow-empty", "-m", "init");
  return cwd;
}

function gitOut(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: testEnv }).trim();
}

/** An empty bare repo — a valid push target that shares no history with the seeded origin. */
function initEmptyBare() {
  const bare = mkdtempSync(join(tmpdir(), "oms-source-"));
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

// --- help / scaffolding / validation (no git operations) ---

test("help is exposed as oms with the submodule commands", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: oms/);
  assert.match(result.stdout, /\binit\b/);
  assert.match(result.stdout, /\bsync\b/);
  assert.match(result.stdout, /\bstatus\b/);
  assert.match(result.stdout, /\bcommit\b/);
  assert.match(result.stdout, /\brecord\b/);
  assert.match(result.stdout, /\bswitch\b/);
  assert.match(result.stdout, /\bcheckout\b/);
  assert.match(result.stdout, /\bunsync\b/);
  assert.match(result.stdout, /\bagent\b/);
  assert.match(result.stdout, /\bupdate\b/);
  assert.doesNotMatch(result.stdout, /\bworktree\b/);
  assert.doesNotMatch(result.stdout, /\bmigrate\b/);
});

test("init scaffolds oms.yaml with the schema comment and does not gitignore oms/", () => {
  const cwd = tempWorkspace();
  const result = run(["init"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);

  const manifest = readFileSync(join(cwd, "oms.yaml"), "utf8");
  assert.match(
    manifest,
    /# yaml-language-server: \$schema=https:\/\/raw\.githubusercontent\.com\/divlook\/oh-my-space\/main\/oms\.schema\.json/,
  );
  assert.match(manifest, /alias: example/);

  // Submodules are tracked, so init must NOT add oms/ to .gitignore.
  if (existsSync(join(cwd, ".gitignore"))) {
    assert.doesNotMatch(readFileSync(join(cwd, ".gitignore"), "utf8"), /^oms\/$/m);
  }
});

test("init removes a stale managed oms/ entry left in .gitignore", () => {
  const cwd = tempWorkspace();
  writeFileSync(join(cwd, ".gitignore"), "node_modules/\n# managed by oms\noms/\n");
  const result = run(["init"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const gi = readFileSync(join(cwd, ".gitignore"), "utf8");
  assert.doesNotMatch(gi, /^oms\/$/m);
  assert.doesNotMatch(gi, /# managed by oms/);
  assert.match(gi, /node_modules\//);
});

test("init refuses to overwrite an existing oms.yaml without --force", () => {
  const cwd = tempWorkspace();
  writeSources(cwd);
  const result = run(["init"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /already exists/);
  assert.match(readFileSync(join(cwd, "oms.yaml"), "utf8"), /alias: sample/);
});

test("init --force overwrites", () => {
  const cwd = tempWorkspace();
  writeSources(cwd);
  const result = run(["init", "--force"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(readFileSync(join(cwd, "oms.yaml"), "utf8"), /alias: example/);
});

test("doctor accepts the init-generated oms.yaml", () => {
  const cwd = tempWorkspace();
  run(["init"], { cwd });
  const result = run(["doctor"], { cwd });
  const output = result.stdout + result.stderr;
  assert.ok(result.status === 0 || result.status === 2, output);
  assert.doesNotMatch(output, /must have at least one item/);
  assert.match(output, /1 repo\(s\) configured/);
});

test("sync --list loads oms.yaml from a parent workspace (no git repo needed)", () => {
  const cwd = tempWorkspace();
  mkdirSync(join(cwd, "nested"));
  writeSources(cwd);

  const result = run(["sync", "--list"], { cwd: join(cwd, "nested") });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /sample/);
  assert.match(result.stdout, /git@example.com:org\/repo.git/);
  assert.match(result.stdout, /main/);
});

test("missing oms.yaml fails with creation guidance", () => {
  const cwd = tempWorkspace();
  const result = run(["sync", "--list"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1);
  assert.match(output, /Could not find oms\.yaml/);
});

test("invalid oms.yaml fails before any disk side effects", () => {
  const cwd = tempWorkspace();
  writeSources(
    cwd,
    "repos:\n  - alias: invalid.alias\n    remotes:\n      origin: git@example.com:org/repo.git\n",
  );

  const result = run(["sync", "sample"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1);
  assert.match(output, /must match/);
  assert.equal(existsSync(join(cwd, "oms")), false);
});

test("sync outside a git repository fails with git init guidance", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace(); // not a git repo
  writeSources(cwd, sourceFor("probe", bare));
  const result = run(["sync", "probe"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /not a git repository/);
  assert.equal(existsSync(join(cwd, "oms")), false);
});

test("unsync rejects an unknown alias", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd);
  const result = run(["unsync", "missing"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /Unknown alias/);
});

test("unsync on a never-synced alias reports nothing to remove with exit 0", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd);
  const result = run(["unsync", "sample"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /nothing to remove/i);
});

// --- submodule lifecycle ---

test("sync registers a submodule on its baseline branch and tracks it in the parent", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("probe", bare));

  const result = run(["sync", "probe"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);

  // .gitmodules registers oms/probe and the working tree is on the branch (not detached).
  const modules = readFileSync(join(cwd, ".gitmodules"), "utf8");
  assert.match(modules, /path = oms\/probe/);
  assert.match(modules, /branch = main/);
  assert.equal(gitOut(join(cwd, "oms", "probe"), "branch", "--show-current"), "main");

  // Default sync leaves topology changes in the working tree, unstaged (not auto-staged). Git collapses
  // the untracked submodule directory to `oms/` until the gitlink is recorded.
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
  const status = gitOut(cwd, "status", "--porcelain");
  assert.match(status, /\.gitmodules/);
  assert.match(status, /oms\//);

  // Submodules are tracked, so oms/ must not be gitignored.
  if (existsSync(join(cwd, ".gitignore"))) {
    assert.doesNotMatch(readFileSync(join(cwd, ".gitignore"), "utf8"), /^oms\/$/m);
  }
});

test("sync accepts aliases with underscore, dash, and at-sign", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  const alias = "alfred_af-101@prod";
  writeSources(cwd, sourceFor(alias, bare));

  const result = run(["sync", alias], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);

  assert.equal(existsSync(join(cwd, "oms", alias, ".git")), true);

  const modules = readFileSync(join(cwd, ".gitmodules"), "utf8");
  assert.match(modules, new RegExp(`path = oms/${alias.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}`));
});

test("sync rejects a missing branch via preflight and leaves no debris", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("probe", bare, "nonexistent"));

  const result = run(["sync", "probe"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /branch "nonexistent" not found/);
  assert.equal(existsSync(join(cwd, "oms", "probe")), false);
  assert.equal(existsSync(join(cwd, ".gitmodules")), false);
});

test("switch creates a brand-new local branch without any remote precondition", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  // feature/new exists neither locally nor on origin — switch must still succeed locally.
  const sw = run(["switch", "api", "feature/new"], { cwd });
  const output = sw.stdout + sw.stderr;
  assert.equal(sw.status, 0, output);
  assert.match(output, /created new local branch/);
  assert.equal(gitOut(join(cwd, "oms", "api"), "branch", "--show-current"), "feature/new");

  // It is a real local branch, not pushed anywhere yet.
  const upstreamCheck = spawnSync(
    "git",
    ["-C", join(cwd, "oms", "api"), "rev-parse", "--abbrev-ref", "feature/new@{u}"],
    { encoding: "utf8", env: testEnv },
  );
  assert.notEqual(upstreamCheck.status, 0);
});

test("switch onto an existing local branch just switches", () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  // Bring dev down as a local branch via checkout, switch back to main, then switch to dev.
  assert.equal(run(["checkout", "api", "dev"], { cwd }).status, 0);
  assert.equal(run(["switch", "api", "main"], { cwd }).status, 0);

  const sw = run(["switch", "api", "dev"], { cwd });
  assert.equal(sw.status, 0, sw.stdout + sw.stderr);
  assert.equal(gitOut(join(cwd, "oms", "api"), "branch", "--show-current"), "dev");
});

test("checkout switches onto an existing remote branch with tracking", () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const co = run(["checkout", "api", "dev"], { cwd });
  assert.equal(co.status, 0, co.stdout + co.stderr);
  assert.equal(gitOut(join(cwd, "oms", "api"), "branch", "--show-current"), "dev");
  assert.equal(
    gitOut(join(cwd, "oms", "api"), "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"),
    "origin/dev",
  );
});

test("checkout refuses a branch absent on origin and points at switch", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  // feature/new exists neither locally nor on origin — checkout is remote-only, so it must refuse.
  const co = run(["checkout", "api", "feature/new"], { cwd });
  const output = co.stdout + co.stderr;
  assert.equal(co.status, 1, output);
  assert.match(output, /not found on origin/);
  assert.match(output, /oms switch api feature\/new/);
});

test("switch and checkout error without hanging when args are omitted in a non-TTY", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  // spawnSync gives a non-TTY stdin, so an omitted alias must fail fast rather than prompt.
  const noAlias = run(["switch"], { cwd });
  assert.equal(noAlias.status, 1, noAlias.stdout + noAlias.stderr);
  assert.match(noAlias.stdout + noAlias.stderr, /not a TTY/);

  // Alias given but branch omitted must also fail fast for both commands.
  const noBranchSwitch = run(["switch", "api"], { cwd });
  assert.equal(noBranchSwitch.status, 1, noBranchSwitch.stdout + noBranchSwitch.stderr);
  assert.match(noBranchSwitch.stdout + noBranchSwitch.stderr, /not a TTY/);

  const noBranchCheckout = run(["checkout", "api"], { cwd });
  assert.equal(noBranchCheckout.status, 1, noBranchCheckout.stdout + noBranchCheckout.stderr);
  assert.match(noBranchCheckout.stdout + noBranchCheckout.stderr, /not a TTY/);
});

test("push lazily creates the remote branch without staging the root pointer", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  // Commit the initial pointer so we can observe the later move cleanly.
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add api");

  // New local branch + a commit, then push (the remote branch does not exist yet).
  assert.equal(run(["switch", "api", "feature/x"], { cwd }).status, 0);
  const wt = join(cwd, "oms", "api");
  writeFileSync(join(wt, "new.txt"), "hi");
  git(wt, "add", "new.txt");
  git(wt, "commit", "-m", "work");
  const localSha = gitOut(wt, "rev-parse", "HEAD");

  const result = run(["push", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /pushed/);

  // The remote branch was created on first push.
  const upstreamSha = gitOut(bare, "rev-parse", "refs/heads/feature/x");
  assert.equal(upstreamSha, localSha);

  // Push never stages the root gitlink; it prints a record hint for the moved pointer instead.
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
  assert.match(output, /oms record api/);
});

test("push --commit is unsupported and fails before pushing", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add api");

  const wt = join(cwd, "oms", "api");
  writeFileSync(join(wt, "f.txt"), "x");
  git(wt, "add", "f.txt");
  git(wt, "commit", "-m", "work");
  const localSha = gitOut(wt, "rev-parse", "HEAD");
  const rootHeadBefore = gitOut(cwd, "rev-parse", "HEAD");

  const result = run(["push", "api", "--commit"], { cwd });
  const output = result.stdout + result.stderr;
  // Usage/config error, migration guidance, no push, no root pointer commit.
  assert.equal(result.status, 1, output);
  assert.match(output, /not supported/);
  assert.match(output, /oms record api/);
  assert.notEqual(gitOut(bare, "rev-parse", "main"), localSha); // nothing pushed
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootHeadBefore); // no root commit
});

test("push --record is unsupported and fails before pushing", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const result = run(["push", "api", "--record"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /not supported/);
  assert.match(output, /oms record api/);
});

test("push fails clearly when the submodule is on a detached HEAD", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  git(join(cwd, "oms", "api"), "checkout", "--detach");

  const result = run(["push", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /detached HEAD/);
});

test("fetch updates origin refs inside the submodule", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const result = run(["fetch", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /fetched/);
});

test("pull --ff-only succeeds on the submodule's branch", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const result = run(["pull", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /pulled/);
});

test("status reports branch, pin state, and dirtiness", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  // Record the gitlink so the root HEAD has a pointer; otherwise the pin is `missing` (pending add).
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add api submodule");

  let result = run(["status"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /ALIAS\s+BRANCH\s+PIN/);
  assert.match(result.stdout, /api\s+main\s+ok/);

  // A dirty working tree shows up in the DIRTY column.
  writeFileSync(join(cwd, "oms", "api", "dirty.txt"), "x");
  result = run(["status", "api"], { cwd });
  assert.match(result.stdout, /api\s+main\s+\S+\s+yes/);
});

// --- status --json (machine-readable workspace state) ---

/** A workspace with `api` synced and its initial gitlink recorded in the root HEAD. */
function workspaceWithApi() {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add api submodule");
  return { cwd, bare, wt: join(cwd, "oms", "api") };
}

/** Parse the JSON object a `status --json` run wrote to stdout, asserting a clean exit. */
function statusJson(cwd, args = [], expectStatus = 0) {
  const result = run(["status", "--json", ...args], { cwd });
  assert.equal(result.status, expectStatus, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}

test("status --json emits one pretty JSON object on stdout with the stable top-level shape", () => {
  const { cwd } = workspaceWithApi();
  const result = run(["status", "--json"], { cwd });
  assert.equal(result.status, 0, result.stderr);

  // Pure JSON: starts with `{`, two-space indented, single trailing newline, no diagnostics.
  assert.ok(result.stdout.startsWith("{"));
  assert.match(result.stdout, /\n  "schemaVersion": 1,/);
  assert.ok(result.stdout.endsWith("}\n"));

  const data = JSON.parse(result.stdout);
  assert.equal(data.schemaVersion, 1);
  assert.equal(typeof data.toolVersion, "string");
  assert.equal(data.workspaceRoot, realpathSync(cwd));
  assert.ok(isAbsolute(data.workspaceRoot));
  assert.equal(data.currentAlias, null);
  assert.ok(Array.isArray(data.errors));
  assert.deepEqual(data.errors, []);
  assert.ok(data.root && typeof data.root === "object");

  const repo = data.repos[0];
  assert.equal(repo.alias, "api");
  assert.equal(repo.path, "oms/api"); // POSIX, workspace-relative
  assert.equal(repo.absolutePath, join(realpathSync(cwd), "oms", "api"));
  assert.equal(repo.configured, true);
  assert.equal(repo.initialized, true);
  assert.equal(repo.pin, "ok");
  assert.equal(repo.error, null);
});

test("status --json reports currentAlias when run inside a configured submodule subtree", () => {
  const { cwd } = workspaceWithApi();
  assert.equal(statusJson(cwd).currentAlias, null);
  assert.equal(statusJson(join(cwd, "oms", "api")).currentAlias, "api");
});

test("status --json current alias inference respects path segment boundaries", () => {
  const { cwd } = workspaceWithApi();
  // oms/api-extra shares a string prefix with alias `api` but is a different segment.
  mkdirSync(join(cwd, "oms", "api-extra"), { recursive: true });
  assert.equal(statusJson(join(cwd, "oms", "api-extra")).currentAlias, null);
});

test("status --json represents a detached submodule HEAD explicitly", () => {
  const { cwd } = workspaceWithApi();
  git(join(cwd, "oms", "api"), "checkout", "--detach");
  const repo = statusJson(cwd).repos[0];
  assert.equal(repo.branch, null);
  assert.equal(repo.detached, true);
  assert.match(repo.head, /^[0-9a-f]+$/);
});

test("status --json reports a missing tracking branch as null divergence", () => {
  const { cwd } = workspaceWithApi();
  // A brand-new local branch has no upstream.
  assert.equal(run(["switch", "api", "feature/x"], { cwd }).status, 0);
  const repo = statusJson(cwd).repos[0];
  assert.equal(repo.trackingBranch, null);
  assert.equal(repo.ahead, null);
  assert.equal(repo.behind, null);
});

test("status --json reports numeric ahead/behind against a tracking branch", () => {
  const { cwd } = workspaceWithApi();
  // main tracks origin/main; one local commit puts it exactly one ahead, zero behind.
  writeFileSync(join(cwd, "oms", "api", "ahead.txt"), "x");
  git(join(cwd, "oms", "api"), "add", "-A");
  git(join(cwd, "oms", "api"), "commit", "-m", "local work");
  const repo = statusJson(cwd).repos[0];
  assert.strictEqual(repo.ahead, 1);
  assert.strictEqual(repo.behind, 0);
});

test("status --json marks a never-synced configured alias as missing, not uninit", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  const repo = statusJson(cwd).repos[0];
  assert.equal(repo.initialized, false);
  assert.equal(repo.pin, "missing");
  assert.equal(repo.head, null);
  assert.equal(repo.error, null);
});

test("status --json keeps a recorded-but-uninitialized repo in inventory as uninit", () => {
  const { cwd } = workspaceWithApi();
  const clone = mkdtempSync(join(tmpdir(), "oms-clone-"));
  execFileSync("git", ["clone", cwd, clone], { stdio: "ignore", env: testEnv });
  configIdentity(clone);
  // The submodule is registered in HEAD but not initialized in the fresh clone.
  const repo = statusJson(clone).repos[0];
  assert.equal(repo.initialized, false);
  assert.equal(repo.pin, "uninit");
  assert.equal(repo.branch, null);
  assert.equal(repo.ahead, null);
});

test("status --json separates root changes from submodule source changes and pointer moves", () => {
  const { cwd } = workspaceWithApi();
  // An unrelated untracked root file is a root change.
  writeFileSync(join(cwd, "NOTES.md"), "hi");
  // A submodule source commit moves the pointer; an extra dirty file lives inside the submodule.
  writeFileSync(join(cwd, "oms", "api", "feature.txt"), "x");
  git(join(cwd, "oms", "api"), "add", "-A");
  git(join(cwd, "oms", "api"), "commit", "-m", "feature");
  writeFileSync(join(cwd, "oms", "api", "scratch.txt"), "y");

  const data = statusJson(cwd);
  // Root counts only the unrelated file, never the moved oms/api gitlink.
  assert.equal(data.root.changes.untracked, 1);
  assert.equal(data.root.changes.staged, 0);
  assert.deepEqual(data.root.submodulePointers.moved, ["api"]);
  // Submodule source changes are authoritative in the repo entry.
  assert.equal(data.repos[0].changes.untracked, 1);
  assert.equal(data.repos[0].dirty, true);
});

test("status --json narrows repos and pointer arrays to the selected aliases", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor([{ alias: "api", bare: a }, { alias: "web", bare: b }]));
  assert.equal(run(["sync", "--all"], { cwd }).status, 0);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add submodules");
  // Move both pointers.
  for (const alias of ["api", "web"]) {
    writeFileSync(join(cwd, "oms", alias, "f.txt"), "x");
    git(join(cwd, "oms", alias), "add", "-A");
    git(join(cwd, "oms", alias), "commit", "-m", "work");
  }

  const data = statusJson(cwd, ["api"]);
  assert.equal(data.repos.length, 1);
  assert.equal(data.repos[0].alias, "api");
  assert.deepEqual(data.root.submodulePointers.moved, ["api"]);
  // Root status and currentAlias remain present even when filtered.
  assert.ok(data.root.branch);
  assert.equal(data.currentAlias, null);
});

test("status --json exposes staged and split root pointer states", () => {
  const { cwd } = workspaceWithApi();
  const wt = join(cwd, "oms", "api");
  // c1: commit in the submodule and stage the gitlink (index ahead of HEAD).
  writeFileSync(join(wt, "c1.txt"), "1");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "c1");
  git(cwd, "add", "oms/api");
  let data = statusJson(cwd);
  assert.deepEqual(data.root.submodulePointers.staged, ["api"]);
  assert.deepEqual(data.root.submodulePointers.moved, ["api"]);
  assert.deepEqual(data.root.submodulePointers.split, []);

  // c2: advance the submodule again so worktree != index != HEAD → split.
  writeFileSync(join(wt, "c2.txt"), "2");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "c2");
  data = statusJson(cwd);
  assert.deepEqual(data.root.submodulePointers.split, ["api"]);
  assert.deepEqual(data.root.submodulePointers.staged, ["api"]);
});

test("status represents a conflicted root gitlink as conflict and still exits 0 for --json", () => {
  const { cwd } = workspaceWithApi();
  const wt = join(cwd, "oms", "api");
  const base = gitOut(wt, "rev-parse", "HEAD");

  // Root branch `x` records pointer B.
  git(cwd, "checkout", "-b", "x");
  writeFileSync(join(wt, "b.txt"), "b");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "B");
  git(cwd, "add", "oms/api");
  git(cwd, "commit", "-m", "ptr B");

  // Back on main, reset the submodule to base and record a divergent pointer C.
  git(cwd, "checkout", "main");
  git(wt, "reset", "--hard", base);
  writeFileSync(join(wt, "c.txt"), "c");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "C");
  git(cwd, "add", "oms/api");
  git(cwd, "commit", "-m", "ptr C");

  // Merging the divergent pointer leaves a conflicted gitlink in the root index.
  const m = spawnSync("git", ["merge", "x"], { cwd, encoding: "utf8", env: testEnv });
  assert.notEqual(m.status, 0, "merge should conflict on the gitlink");

  const data = statusJson(cwd); // exits 0 despite the conflict
  assert.equal(data.repos[0].pin, "conflict");
  assert.deepEqual(data.root.submodulePointers.conflict, ["api"]);

  // The human-readable table also shows the conflict pin.
  const table = run(["status"], { cwd });
  assert.match(table.stdout, /api\s+\S*\s*conflict/);
});

test("status --json fails before emitting JSON for an unknown alias", () => {
  const { cwd } = workspaceWithApi();
  const result = run(["status", "missing-alias", "--json"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Unknown alias/);
});

test("status --json keeps valid JSON and exits non-zero when a repo read fails", () => {
  const { cwd } = workspaceWithApi();
  // Remove the submodule's real gitdir so its HEAD cannot be read, while the .git pointer file remains.
  rmSync(join(cwd, ".git", "modules", "oms", "api"), { recursive: true, force: true });

  const result = run(["status", "--json"], { cwd });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  const data = JSON.parse(result.stdout); // stdout stays valid JSON
  const repo = data.repos[0];
  assert.equal(typeof repo.error, "string");
  assert.equal(repo.head, null);
  // Structured fields keep their normal shape with safe defaults.
  assert.deepEqual(repo.changes, { staged: 0, unstaged: 0, untracked: 0 });
  assert.equal(data.errors.length, 1);
});

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
  assert.match(output, /oms switch api/);
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

test("commit infers the alias before preconditions and fails when uninitialized", () => {
  const { cwd } = workspaceWithApi();
  const clone = mkdtempSync(join(tmpdir(), "oms-clone-"));
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

/** A workspace with `api` recorded, then advanced by one submodule commit (pointer moved, unrecorded). */
function workspaceWithMovedApi() {
  const { cwd, bare } = workspaceWithApi();
  const wt = join(cwd, "oms", "api");
  writeFileSync(join(wt, "f.txt"), "x");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "work");
  return { cwd, bare, wt };
}

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

  const result = run(["record", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /left in place/);
  // The selected gitlink remains staged for retry.
  assert.match(gitOut(cwd, "diff", "--cached", "--name-only"), /oms\/api/);
});

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

test("sync --commit refuses to commit when unrelated root paths are staged", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  writeFileSync(join(cwd, "keep.txt"), "x");
  git(cwd, "add", "keep.txt");

  const result = run(["sync", "api", "--commit"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /unrelated staged changes/);
  // No topology commit; the unrelated file stays staged and the topology is returned to unstaged.
  assert.notEqual(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
  const staged = gitOut(cwd, "diff", "--cached", "--name-only");
  assert.match(staged, /keep\.txt/);
  assert.doesNotMatch(staged, /\.gitmodules/);
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

test("multi-alias sync --commit skips the topology commit when an alias fails", () => {
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
  assert.equal(result.status, 2, output); // web failed
  // No topology commit and api's topology is returned to unstaged for manual review.
  assert.notEqual(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add submodules");
  assert.notEqual(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
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
  assert.match(output, /oms switch api/);
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
function agentWorkspace() {
  const cwd = tempWorkspace();
  writeSources(cwd);
  return cwd;
}

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
    assert.match(content, /separate Git repositor/);
    assert.match(content, /do not guess/i);
    assert.match(content, /oms record <alias>/);
    assert.match(content, /oms --help/);
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

test("commit help explains the submodule scope with an example", () => {
  const result = run(["commit", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /submodule only/);
  assert.match(result.stdout, /never the root gitlink/);
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

test("status help documents the schemaVersion 1 field contract", () => {
  const result = run(["status", "--help"]);
  assert.equal(result.status, 0);
  // Names every schemaVersion 1 top-level key.
  for (const key of [
    "schemaVersion",
    "toolVersion",
    "workspaceRoot",
    "currentAlias",
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

// --- doctor ---

test("doctor reports workspace, manifest count, git, and warns when not a git repo", () => {
  const cwd = tempWorkspace();
  writeSources(cwd);
  const result = run(["doctor"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /Workspace root:/);
  assert.match(output, /oms\.yaml: 1 repo\(s\) configured/);
  assert.match(output, /git:/);
  assert.match(output, /not a git repository/);
});

test("doctor reports a healthy submodule after sync", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const result = run(["doctor"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /api: submodule OK \(branch=main\)/);
});

test("doctor warns when .gitignore still excludes oms/", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  writeFileSync(join(cwd, ".gitignore"), "oms/\n");

  const result = run(["doctor"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /\.gitignore excludes oms\//);
});

test("doctor warns when git is older than the recommended 2.40", () => {
  const cwd = tempWorkspace();
  writeSources(cwd);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const stubDir = mkdtempSync(join(tmpdir(), "oms-git-stub-"));
  const stubGit = join(stubDir, "git");
  writeFileSync(
    stubGit,
    `#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "git version 2.30.0"; exit 0; fi\nexec ${realGit} "$@"\n`,
  );
  execFileSync("chmod", ["+x", stubGit]);

  const result = run(["doctor"], {
    cwd,
    env: { ...testEnv, PATH: `${stubDir}:${process.env.PATH}` },
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /git 2\.30 is older than the recommended 2\.40/);
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

// --- self update ---

test("update --check reports up to date without detecting install context", () => {
  const result = run(["update", "--check"], {
    env: updateEnv({
      OMS_TEST_REGISTRY_RESPONSE: JSON.stringify({ "dist-tags": { latest: currentVersion } }),
      OMS_TEST_INSTALL_CONTEXT: installContext("global", {
        updateCommand: { executable: "npm", args: ["install", "-g", "oh-my-space@latest"] },
      }),
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /up to date/i);
  assert.doesNotMatch(output, /Detected context/);
});

test("update --check reports update availability and global command", () => {
  const result = run(["update", "--check"], {
    env: updateEnv({
      OMS_TEST_INSTALL_CONTEXT: installContext("global", {
        label: "global npm install",
        updateCommand: { executable: "npm", args: ["install", "-g", "oh-my-space@latest"] },
      }),
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, versionPattern(`Current version: ${currentVersion}`));
  assert.match(output, versionPattern(`Latest version: ${newerVersion}`));
  assert.match(output, /Update available/);
  assert.match(output, /Detected context: global npm install/);
  assert.match(output, /Selected command: npm install -g oh-my-space@latest/);
});

test("update fails cleanly when registry latest is unavailable", () => {
  const result = run(["update", "--check"], {
    env: updateEnv({ OMS_TEST_REGISTRY_RESPONSE: JSON.stringify({ "dist-tags": {} }) }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /missing dist-tags\.latest/);
  assert.doesNotMatch(output, /Selected command/);
});

test("update treats invalid registry semver as a failure", () => {
  const result = run(["update", "--check"], {
    env: updateEnv({ OMS_TEST_REGISTRY_RESPONSE: JSON.stringify({ "dist-tags": { latest: "not-semver" } }) }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /not valid semver/);
});

test("update treats current newer than registry latest as non-mutating success", () => {
  const result = run(["update"], {
    env: updateEnv({ OMS_TEST_REGISTRY_RESPONSE: JSON.stringify({ "dist-tags": { latest: "0.0.0" } }) }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /newer than the npm registry latest/);
  assert.doesNotMatch(output, /Detected context/);
});

test("update detects global npm context from runtime evidence", () => {
  const prefix = tempWorkspace();
  const packageRoot = join(prefix, "lib", "node_modules", "oh-my-space");
  const runningBin = join(packageRoot, "dist", "oms.js");
  const pathBin = join(prefix, "bin", "oms");
  const result = run(["update", "--check"], {
    env: updateEnv({
      OMS_TEST_RUNTIME_EVIDENCE: JSON.stringify({
        packageRoot,
        realPackageRoot: packageRoot,
        runningBin,
        realRunningBin: runningBin,
        pathBin,
        realPathBin: pathBin,
        packageName: "oh-my-space",
      }),
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Detected context: global npm install/);
  assert.match(output, /npm install -g oh-my-space@latest/);
});

test("update detects global npm context when PATH shim realpath points into package", () => {
  const prefix = tempWorkspace();
  const packageRoot = join(prefix, "lib", "node_modules", "oh-my-space");
  const runningBin = join(packageRoot, "dist", "oms.js");
  const pathBin = join(prefix, "bin", "oms");
  const result = run(["update", "--check"], {
    env: updateEnv({
      OMS_TEST_RUNTIME_EVIDENCE: JSON.stringify({
        packageRoot,
        realPackageRoot: packageRoot,
        runningBin,
        realRunningBin: runningBin,
        pathBin,
        realPathBin: runningBin,
        packageName: "oh-my-space",
      }),
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Detected context: global npm install/);
  assert.match(output, /npm install -g oh-my-space@latest/);
});

test("update detects Windows npm global context from runtime evidence", () => {
  const result = run(["update", "--check"], {
    env: updateEnv({
      OMS_TEST_RUNTIME_EVIDENCE: JSON.stringify({
        packageRoot: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\oh-my-space",
        realPackageRoot: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\oh-my-space",
        runningBin: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\oh-my-space\\dist\\oms.js",
        realRunningBin: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\oh-my-space\\dist\\oms.js",
        pathBin: "C:\\Users\\me\\AppData\\Roaming\\npm\\oms.cmd",
        realPathBin: "C:\\Users\\me\\AppData\\Roaming\\npm\\oms.cmd",
        packageName: "oh-my-space",
      }),
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Detected context: global npm install/);
  assert.match(output, /npm install -g oh-my-space@latest/);
});

test("update resolves Windows npm global shim extensions from PATH", () => {
  const prefix = tempWorkspace();
  const packageRoot = join(prefix, "node_modules", "oh-my-space");
  const modulePath = join(packageRoot, "dist", "oms.js");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "oh-my-space" }));
  writeFileSync(modulePath, "");
  writeFileSync(join(prefix, "oms.cmd"), "");

  const result = run(["update", "--check"], {
    env: updateEnv({
      OMS_TEST_PLATFORM: "win32",
      OMS_TEST_MODULE_PATH: modulePath,
      OMS_TEST_ARGV1: modulePath,
      PATH: `${prefix}${process.env.PATH ? `${delimiter}${process.env.PATH}` : ""}`,
      PATHEXT: ".CMD;.PS1;.EXE",
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Detected context: global npm install/);
  assert.match(output, /npm install -g oh-my-space@latest/);
});

test("update does not treat project lib node_modules as global npm", () => {
  const project = tempWorkspace();
  const packageRoot = join(project, "lib", "node_modules", "oh-my-space");
  const runningBin = join(packageRoot, "dist", "oms.js");
  const pathBin = join(project, "node_modules", ".bin", "oms");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ devDependencies: { "oh-my-space": "0.9.0" } }));

  const result = run(["update", "--yes"], {
    env: updateEnv({
      OMS_TEST_RUNTIME_EVIDENCE: JSON.stringify({
        packageRoot,
        realPackageRoot: packageRoot,
        runningBin,
        realRunningBin: runningBin,
        pathBin,
        realPathBin: pathBin,
        packageName: "oh-my-space",
      }),
      OMS_TEST_MANAGER_AVAILABLE: "1",
      OMS_TEST_UPDATE_EXIT: "0",
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Detected context: project-local install/);
  assert.match(output, /Automatic update is only supported/);
  assert.doesNotMatch(output, /Update command completed/);
});

test("update does not treat project paths containing pnpm global tokens as global", () => {
  const project = join(tempWorkspace(), "pnpm", "global", "app");
  const packageRoot = join(project, "node_modules", "oh-my-space");
  const runningBin = join(packageRoot, "dist", "oms.js");
  const pathBin = join(project, "node_modules", ".bin", "oms");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ devDependencies: { "oh-my-space": "0.9.0" } }));

  const result = run(["update", "--yes"], {
    env: updateEnv({
      OMS_TEST_RUNTIME_EVIDENCE: JSON.stringify({
        packageRoot,
        realPackageRoot: packageRoot,
        runningBin,
        realRunningBin: runningBin,
        pathBin,
        realPathBin: runningBin,
        packageName: "oh-my-space",
      }),
      OMS_TEST_MANAGER_AVAILABLE: "1",
      OMS_TEST_UPDATE_EXIT: "0",
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Detected context: project-local install/);
  assert.match(output, /Automatic update is only supported/);
  assert.doesNotMatch(output, /Update command completed/);
});

test("update treats unresolved node_modules installs as unknown", () => {
  const root = tempWorkspace();
  const packageRoot = join(root, "node_modules", "oh-my-space");
  const runningBin = join(packageRoot, "dist", "oms.js");
  const result = run(["update", "--yes"], {
    env: updateEnv({
      OMS_TEST_RUNTIME_EVIDENCE: JSON.stringify({
        packageRoot,
        realPackageRoot: packageRoot,
        runningBin,
        realRunningBin: runningBin,
        pathBin: null,
        realPathBin: null,
        packageName: "oh-my-space",
      }),
      OMS_TEST_MANAGER_AVAILABLE: "1",
      OMS_TEST_UPDATE_EXIT: "0",
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Detected context: unknown install context/);
  assert.match(output, /Automatic update is only supported/);
  assert.doesNotMatch(output, /project-local install/);
  assert.doesNotMatch(output, /Update command completed/);
});

test("update detects pnpm global context only with matching global shim", () => {
  const prefix = tempWorkspace();
  const packageRoot = join(prefix, "global", "5", "node_modules", "oh-my-space");
  const runningBin = join(packageRoot, "dist", "oms.js");
  const pathBin = join(prefix, "oms");
  const result = run(["update", "--check"], {
    env: updateEnv({
      OMS_TEST_RUNTIME_EVIDENCE: JSON.stringify({
        packageRoot,
        realPackageRoot: packageRoot,
        runningBin,
        realRunningBin: runningBin,
        pathBin,
        realPathBin: runningBin,
        packageName: "oh-my-space",
      }),
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Detected context: global pnpm install/);
  assert.match(output, /pnpm add -g oh-my-space@latest/);
});

test("update reports non-mutating contexts with guidance", () => {
  for (const kind of ["project", "ephemeral", "development", "unknown"]) {
    const result = run(["update", "--yes"], {
      env: updateEnv({ OMS_TEST_INSTALL_CONTEXT: installContext(kind) }),
    });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 0, output);
    assert.match(output, new RegExp(`${kind} test install`));
    assert.match(output, /Automatic update is only supported/);
    assert.match(output, new RegExp(`guidance for ${kind}`));
  }
});

test("update --yes runs a confident global command and warns on verification mismatch", () => {
  const result = run(["update", "--yes"], {
    env: updateEnv({
      OMS_TEST_INSTALL_CONTEXT: installContext("global", {
        label: "global pnpm install",
        updateCommand: { executable: "pnpm", args: ["add", "-g", "oh-my-space@latest"] },
      }),
      OMS_TEST_MANAGER_AVAILABLE: "1",
      OMS_TEST_UPDATE_EXIT: "0",
      OMS_TEST_VERIFY_VERSION: currentVersion,
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Selected command: pnpm add -g oh-my-space@latest/);
  assert.match(output, versionPattern(`Post-update verification saw ${currentVersion}, expected ${newerVersion}`));
  assert.match(output, /Update command completed/);
});

test("update without --yes in non-interactive mode does not mutate", () => {
  const result = run(["update"], {
    env: updateEnv({
      OMS_TEST_INSTALL_CONTEXT: installContext("global", {
        updateCommand: { executable: "bun", args: ["add", "-g", "oh-my-space@latest"] },
      }),
      OMS_TEST_MANAGER_AVAILABLE: "1",
      OMS_TEST_UPDATE_EXIT: "0",
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Re-run with --yes/);
  assert.doesNotMatch(output, /Update command completed/);
});

test("update without --yes in non-interactive mode does not require manager availability", () => {
  const result = run(["update"], {
    env: updateEnv({
      OMS_TEST_INSTALL_CONTEXT: installContext("global", {
        updateCommand: { executable: "npm", args: ["install", "-g", "oh-my-space@latest"] },
      }),
      OMS_TEST_MANAGER_AVAILABLE: "0",
      OMS_TEST_UPDATE_EXIT: "0",
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Re-run with --yes/);
  assert.doesNotMatch(output, /not executable from PATH/);
});

test("update normalizes package-manager failure to exit 1", () => {
  const result = run(["update", "--yes"], {
    env: updateEnv({
      OMS_TEST_INSTALL_CONTEXT: installContext("global", {
        updateCommand: { executable: "yarn", args: ["global", "add", "oh-my-space@latest"] },
      }),
      OMS_TEST_MANAGER_AVAILABLE: "1",
      OMS_TEST_UPDATE_EXIT: "7",
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /Package manager update failed \(exit 7\)/);
});

test("update fails before mutation when detected manager is unavailable", () => {
  const result = run(["update", "--yes"], {
    env: updateEnv({
      OMS_TEST_INSTALL_CONTEXT: installContext("global", {
        updateCommand: { executable: "npm", args: ["install", "-g", "oh-my-space@latest"] },
      }),
      OMS_TEST_MANAGER_AVAILABLE: "0",
      OMS_TEST_UPDATE_EXIT: "0",
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /not executable from PATH/);
  assert.doesNotMatch(output, /Update command completed/);
});
