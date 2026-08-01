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
} from "./helpers.js";

// --- submodule lifecycle ---

test("fixture template clones isolate refs and configuration", () => {
  const first = initBareUpstream();
  const second = initBareUpstream();
  git(first, "branch", "isolated", "main");
  git(first, "config", "oms.fixture", "first");

  assert.equal(gitOut(first, "config", "--get", "oms.fixture"), "first");
  assert.equal(gitOut(first, "branch", "--list", "isolated"), "isolated");
  assert.equal(gitOut(second, "branch", "--list", "isolated"), "");
  assert.equal(spawnSync("git", ["-C", second, "config", "--get", "oms.fixture"]).status, 1);

  const afterMutation = initBareUpstream();
  assert.equal(gitOut(afterMutation, "branch", "--list", "isolated"), "");
  assert.equal(spawnSync("git", ["-C", afterMutation, "config", "--get", "oms.fixture"]).status, 1);

  const firstWorkspace = workspaceWithApi();
  git(firstWorkspace.cwd, "branch", "isolated-root", "main");
  git(firstWorkspace.cwd, "config", "oms.fixture", "first");
  const secondWorkspace = workspaceWithApi();
  assert.equal(gitOut(secondWorkspace.cwd, "branch", "--list", "isolated-root"), "");
  assert.equal(spawnSync("git", ["-C", secondWorkspace.cwd, "config", "--get", "oms.fixture"]).status, 1);
});

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

  // Default sync records the topology in one root commit, so nothing is left staged or dirty.
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add probe submodule");
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
  assert.equal(gitOut(cwd, "status", "--porcelain"), "");
  // The gitlink and .gitmodules are what that commit contains.
  const committed = gitOut(cwd, "show", "--name-only", "--pretty=format:", "HEAD");
  assert.match(committed, /\.gitmodules/);
  assert.match(committed, /oms\/probe/);

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
  const sw = run(["branch", "switch", "api", "feature/new"], { cwd });
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
  assert.equal(run(["branch", "checkout", "api", "dev"], { cwd }).status, 0);
  assert.equal(run(["branch", "switch", "api", "main"], { cwd }).status, 0);

  const sw = run(["branch", "switch", "api", "dev"], { cwd });
  assert.equal(sw.status, 0, sw.stdout + sw.stderr);
  assert.equal(gitOut(join(cwd, "oms", "api"), "branch", "--show-current"), "dev");
});

test("checkout switches onto an existing remote branch with tracking", () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const co = run(["branch", "checkout", "api", "dev"], { cwd });
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
  const co = run(["branch", "checkout", "api", "feature/new"], { cwd });
  const output = co.stdout + co.stderr;
  assert.equal(co.status, 1, output);
  assert.match(output, /not found on origin/);
  assert.match(output, /oms branch switch api feature\/new/);
});

test("switch and checkout error without hanging when args are omitted in a non-TTY", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  // spawnSync gives a non-TTY stdin, so an omitted alias must fail fast rather than prompt.
  const noAlias = run(["branch", "switch"], { cwd });
  assert.equal(noAlias.status, 1, noAlias.stdout + noAlias.stderr);
  assert.match(noAlias.stdout + noAlias.stderr, /not a TTY/);

  // Alias given but branch omitted must also fail fast for both commands.
  const noBranchSwitch = run(["branch", "switch", "api"], { cwd });
  assert.equal(noBranchSwitch.status, 1, noBranchSwitch.stdout + noBranchSwitch.stderr);
  assert.match(noBranchSwitch.stdout + noBranchSwitch.stderr, /not a TTY/);

  const noBranchCheckout = run(["branch", "checkout", "api"], { cwd });
  assert.equal(noBranchCheckout.status, 1, noBranchCheckout.stdout + noBranchCheckout.stderr);
  assert.match(noBranchCheckout.stdout + noBranchCheckout.stderr, /not a TTY/);
});

test("push lazily creates the remote branch without staging the root pointer", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api", "--no-commit"], { cwd }).status, 0);
  // Commit the initial pointer so we can observe the later move cleanly.
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add api");

  // New local branch + a commit, then push (the remote branch does not exist yet).
  assert.equal(run(["branch", "switch", "api", "feature/x"], { cwd }).status, 0);
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
  assert.equal(run(["sync", "api", "--no-commit"], { cwd }).status, 0);
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

test("push fails clearly when detached HEAD has no local branch at its commit", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const dir = join(cwd, "oms", "api");
  git(dir, "commit", "--allow-empty", "-m", "detached tip");
  git(dir, "checkout", "--detach");
  git(dir, "branch", "-f", "main", "HEAD^");

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
  assert.equal(run(["sync", "api", "--no-commit"], { cwd }).status, 0);
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

test("status --json keeps its schema and path representation through a symlinked cwd", () => {
  const { cwd } = workspaceWithApi();
  const linkParent = tempWorkspace();
  const linked = join(linkParent, "workspace");
  symlinkSync(cwd, linked);

  const data = statusJson(linked);
  assert.deepEqual(Object.keys(data).sort(), [
    "currentAlias",
    "errors",
    "repos",
    "root",
    "schemaVersion",
    "toolVersion",
    "workspaceRoot",
  ]);
  assert.equal(data.workspaceRoot, realpathSync(cwd));
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
  assert.equal(run(["branch", "switch", "api", "feature/x"], { cwd }).status, 0);
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
  const clone = tempFixture("oms-clone-");
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
  assert.equal(run(["sync", "--all", "--no-commit"], { cwd }).status, 0);
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


// --- root-safe sync/unsync topology and pull/push ---

test("sync --commit creates a single-alias add topology commit", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));

  const result = run(["sync", "api", "--commit"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
});

test("the topology commit default does not depend on stdin being a terminal", () => {
  // Every run() here is non-interactive (spawnSync gives a pipe), which is exactly the shell that
  // previously skipped the prompt and silently left the topology unstaged.
  const bare = initBareUpstream();

  const plain = initGitWorkspace();
  writeSources(plain, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd: plain }).status, 0);

  const flagged = initGitWorkspace();
  writeSources(flagged, sourceFor("api", bare));
  assert.equal(run(["sync", "api", "--commit"], { cwd: flagged }).status, 0);

  // No flag and --commit must be indistinguishable.
  for (const cwd of [plain, flagged]) {
    assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
    assert.equal(gitOut(cwd, "status", "--porcelain"), "");
    assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
  }
  assert.equal(
    gitOut(plain, "rev-list", "--count", "HEAD"),
    gitOut(flagged, "rev-list", "--count", "HEAD"),
  );
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

test("--no-commit leaves topology unstaged and preserves unrelated staged paths", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  writeFileSync(join(cwd, "unrelated.txt"), "keep me staged");
  git(cwd, "add", "unrelated.txt");
  const headBefore = gitOut(cwd, "rev-parse", "HEAD");

  assert.equal(run(["sync", "api", "--no-commit"], { cwd }).status, 0);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), headBefore);
  assert.match(gitOut(cwd, "diff", "--cached", "--name-only"), /^unrelated\.txt$/m);
  assert.doesNotMatch(gitOut(cwd, "diff", "--cached", "--name-only"), /\.gitmodules/);
  assert.match(gitOut(cwd, "status", "--porcelain"), /\.gitmodules/);
});

test("multi-alias sync still produces one plural topology commit by default", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor([{ alias: "api", bare: a }, { alias: "web", bare: b }]));
  const before = Number(gitOut(cwd, "rev-list", "--count", "HEAD"));

  assert.equal(run(["sync", "api", "web"], { cwd }).status, 0);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add submodules");
  assert.equal(Number(gitOut(cwd, "rev-list", "--count", "HEAD")), before + 1);
});

test("delegated preparation sync commits its topology", () => {
  // branch list prepares an unregistered alias through runSync with no commit option. Under the old
  // default that left the topology unstaged, which made the alias partially registered and broke the
  // next invocation; the single queue entry drives only the sync-or-cancel selector.
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

test("sync --commit records pending add topology left by an earlier no-commit sync", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  // --no-commit is what actually leaves pending topology now; without it the first sync commits and
  // the second call finds nothing to record, making every assertion below vacuous.
  assert.equal(run(["sync", "api", "--no-commit"], { cwd }).status, 0);
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), ""); // left unstaged
  const before = Number(gitOut(cwd, "rev-list", "--count", "HEAD"));

  const result = run(["sync", "api", "--commit"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
  // A new commit, not the one an earlier default-commit sync would already have made.
  assert.equal(Number(gitOut(cwd, "rev-list", "--count", "HEAD")), before + 1);
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

test("omitted selection fails with an actionable message in a non-interactive shell", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor([{ alias: "api", bare: a }, { alias: "web", bare: b }]));
  assert.equal(run(["sync", "--all"], { cwd }).status, 0);

  // Every set command shares one selection resolver, so one guard covers all of them. Without it the
  // prompt opens and never settles, ending in Node's unsettled-top-level-await exit rather than a
  // usage error naming the missing selection.
  for (const command of ["sync", "fetch", "pull", "unsync", "push"]) {
    const result = run([command], { cwd });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 1, `${command}: ${output}`);
    assert.match(output, /not a TTY/, command);
    assert.match(output, new RegExp(`oms ${command} --all`), command);
  }
});

test("guarded multiselect drives an omitted selection and fails closed when malformed", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor([{ alias: "api", bare: a }, { alias: "web", bare: b }]));

  // An injected multiselect response stands in for the TTY and narrows the selection to one alias.
  const picked = run(["sync"], { cwd, env: queueEnv([{ type: "multiselect", values: ["api"] }]) });
  assert.equal(picked.status, 0, picked.stdout + picked.stderr);
  assert.equal(existsSync(join(cwd, "oms", "api")), true);
  assert.equal(existsSync(join(cwd, "oms", "web")), false);

  // A non-string entry in "values" is rejected before any prompt opens.
  const malformed = run(["sync"], { cwd, env: queueEnv([{ type: "multiselect", values: ["api", 7] }]) });
  assert.equal(malformed.status, 1, malformed.stdout + malformed.stderr);
  assert.match(malformed.stdout + malformed.stderr, /must be an array of strings/);

  // A select response cannot satisfy a multiselect prompt.
  const wrongType = run(["sync"], { cwd, env: queueEnv([{ type: "select", value: "api" }]) });
  assert.equal(wrongType.status, 1, wrongType.stdout + wrongType.stderr);
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
  // --no-commit is what leaves the removal pending; a plain unsync now records it immediately.
  assert.equal(run(["unsync", "api", "--no-commit"], { cwd }).status, 0);
  assert.equal(existsSync(join(cwd, "oms", "api")), false);
  const before = Number(gitOut(cwd, "rev-list", "--count", "HEAD"));

  const result = run(["unsync", "api", "--commit"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): remove api submodule");
  assert.equal(Number(gitOut(cwd, "rev-list", "--count", "HEAD")), before + 1);
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
  assert.equal(run(["unsync", "api", "--no-commit"], { cwd }).status, 0);
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
  assert.equal(run(["sync", "--all", "--no-commit"], { cwd }).status, 0);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add submodules");
  writeFileSync(join(cwd, ".gitmodules"), `${readFileSync(join(cwd, ".gitmodules"), "utf8")}# keep web edit\n`);

  // The removal must stay uncommitted, or the gitlink leaves HEAD and the next sync takes the
  // fresh-add path instead of restorePendingRemoval — the scoped restore this test exists for.
  assert.equal(run(["unsync", "api", "--no-commit"], { cwd }).status, 0);
  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /restored pending removal/);

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

  // The subject of this test: restore rebuilds sections in their original order rather than appending.
  const sections = [...readFileSync(join(cwd, ".gitmodules"), "utf8")
    .matchAll(/^\[submodule "oms\/([^"]+)"\]/gm)].map((m) => m[1]);
  assert.deepEqual(sections, ["api", "web", "docs"]);
  assert.equal(gitOut(cwd, "status", "--porcelain"), "");
});

test("sync restore removes a metadata-only alias directory before initialization", () => {
  const { cwd } = workspaceWithApi();
  assert.equal(run(["unsync", "api", "--no-commit"], { cwd }).status, 0);
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
  assert.equal(run(["unsync", "api", "--no-commit"], { cwd }).status, 0);
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
  assert.equal(run(["unsync", "api", "--no-commit"], { cwd }).status, 0);
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
  assert.equal(run(["unsync", "api", "--no-commit"], { cwd }).status, 0);

  const result = run(["sync", "api", "--no-commit"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /reconciled \.gitmodules/);
  assert.match(readFileSync(join(cwd, ".gitmodules"), "utf8"), new RegExp(`url = file://${bare.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}/`));
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
  assert.match(gitOut(cwd, "diff", "--name-only"), /^\.gitmodules$/m);
});

test("unsync refuses and preserves a non-submodule path occupying the alias", () => {
  const { cwd } = workspaceWithApi();
  // Remove api (the default commits the removal), then drop a non-submodule file at oms/api. The
  // occupied-path preflight reads the registration and directory state, never root HEAD, so whether
  // the removal was committed makes no difference to what this test asserts.
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
const skipUnreadable =
  typeof process.getuid === "function" && process.getuid() === 0
    ? { skip: "chmod 0o000 is not enforced when running as root" }
    : {};

test("unsync refuses when oms/<alias> is unreadable", skipUnreadable, () => {
  const { cwd } = workspaceWithApi();
  // Remove api (the default commits the removal), then make oms/api unreadable. As above, the
  // preflight does not consult root HEAD, so the committed removal does not change the outcome.
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
  assert.equal(run(["unsync", "api", "--no-commit"], { cwd }).status, 0);
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

test("unsync --no-commit removes a normal registered submodule and leaves the removal topology", () => {
  const { cwd } = workspaceWithApi();
  const result = run(["unsync", "api", "--no-commit"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /api: unsynced/);
  assert.equal(existsSync(join(cwd, "oms", "api")), false);
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
  const before = Number(gitOut(cwd, "rev-list", "--count", "HEAD"));

  assert.equal(run(["unsync", "api", "--commit"], { cwd }).status, 0);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): remove api submodule");
  assert.equal(Number(gitOut(cwd, "rev-list", "--count", "HEAD")), before + 1);
});

test("pull rejects a dirty submodule before running", () => {
  const { cwd, wt } = workspaceWithApi();
  writeFileSync(join(wt, "dirty.txt"), "x");

  const result = run(["pull", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /uncommitted changes/);
});

test("pull rejects detached HEAD with no local branch at its commit", () => {
  const { cwd, wt } = workspaceWithApi();
  git(wt, "commit", "--allow-empty", "-m", "detached tip");
  git(wt, "checkout", "--detach");
  git(wt, "branch", "-f", "main", "HEAD^");

  const result = run(["pull", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /detached HEAD/);
  assert.match(output, /oms branch switch api/);
});

test("pull advances the submodule branch without staging and hints record", () => {
  const { cwd, bare } = workspaceWithApi();
  // Advance origin/main from a scratch clone so there is something to pull.
  const scratch = tempFixture("oms-scratch-");
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

test("sync and unsync help document the commit-by-default topology behavior", () => {
  const sync = run(["sync", "--help"]);
  assert.match(sync.stdout, /committed by default/);
  assert.match(sync.stdout, /--no-commit/);
  assert.match(sync.stdout, /oms sync api --no-commit/);
  // --commit stays documented as an accepted no-op so existing invocations keep working.
  assert.match(sync.stdout, /oms sync api --commit/);
  assert.doesNotMatch(sync.stdout, /left unstaged by default/);

  const unsync = run(["unsync", "--help"]);
  assert.match(unsync.stdout, /committed by default/);
  assert.match(unsync.stdout, /oms unsync api --no-commit/);
  assert.match(unsync.stdout, /oms unsync api --commit/);
  assert.doesNotMatch(unsync.stdout, /left unstaged by default/);
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

  assert.equal(run(["sync", "api", "--no-commit"], { cwd }).status, 0);
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

  // unsync commits the removal itself, so re-sync already starts from a clean index.
  assert.equal(gitOut(cwd, "status", "--porcelain"), "");

  const resynced = run(["sync", "api"], { cwd });
  assert.equal(resynced.status, 0, resynced.stdout + resynced.stderr);
  assert.ok(existsSync(join(cwd, "oms", "api", ".git")));
  assert.equal(gitOut(join(cwd, "oms", "api"), "branch", "--show-current"), "main");
});


test("unsync of all aliases leaves no orphan .gitmodules section", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const c = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor([{ alias: "api", bare: a }, { alias: "web", bare: b }, { alias: "docs", bare: c }]));
  assert.equal(run(["sync", "--all", "--no-commit"], { cwd }).status, 0);
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
  assert.equal(run(["sync", "--all", "--no-commit"], { cwd }).status, 0);
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
  assert.equal(run(["sync", "api", "--no-commit"], { cwd }).status, 0);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add api submodule");
  const pin = gitOut(cwd, "rev-parse", `:oms/api`);

  // Clone the parent elsewhere; the submodule is registered but not yet initialized.
  const clone = tempFixture("oms-clone-");
  execFileSync("git", ["clone", cwd, clone], { stdio: "ignore", env: testEnv });
  configIdentity(clone);
  assert.equal(existsSync(join(clone, "oms", "api", ".git")), false);

  const result = run(["sync", "api"], { cwd: clone });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(join(clone, "oms", "api"), "rev-parse", "HEAD"), pin);
  assert.equal(gitOut(join(clone, "oms", "api"), "branch", "--show-current"), "main");
});
