import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import { testEnv, run, tempWorkspace, writeSources, git, configIdentity, initBareUpstream, initGitWorkspace, gitOut, sourceFor, workspaceWithApi, statusJson, workspaceWithMovedApi, sourcesFor } from "./helpers.js";
// --- status --json (machine-readable workspace state) ---



test("status --json emits one pretty JSON object on stdout with the stable top-level shape", () => {
  const { cwd } = workspaceWithApi();
  const result = run(["status", "--json"], { cwd });
  assert.equal(result.status, 0, result.stderr);

  // Pure JSON: starts with `{`, two-space indented, single trailing newline, no diagnostics.
  assert.ok(result.stdout.startsWith("{"));
  assert.match(result.stdout, /\n  "schemaVersion": 2,/);
  assert.ok(result.stdout.endsWith("}\n"));

  const data = JSON.parse(result.stdout);
  assert.equal(data.schemaVersion, 2);
  assert.equal(data.mode, "submodule");
  assert.equal(typeof data.toolVersion, "string");
  assert.equal(data.workspaceRoot, realpathSync(cwd));
  assert.ok(isAbsolute(data.workspaceRoot));
  assert.equal(data.currentAlias, null);
  assert.equal(data.currentWorktree, null);
  assert.equal(data.currentTarget, null);
  assert.ok(Array.isArray(data.errors));
  assert.deepEqual(data.errors, []);
  assert.ok(data.root && typeof data.root === "object");

  const repo = data.repos[0];
  assert.equal(repo.mode, "submodule");
  assert.equal(repo.alias, "api");
  assert.equal(repo.path, "oms/api"); // POSIX, workspace-relative
  assert.equal(repo.absolutePath, join(realpathSync(cwd), "oms", "api"));
  assert.equal(repo.configured, true);
  assert.equal(repo.initialized, true);
  assert.equal(repo.pin, "ok");
  assert.equal(repo.error, null);
  const schema = JSON.parse(readFileSync(resolve("oms.status.schema.json"), "utf8"));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(data), true, JSON.stringify(validate.errors));
});

test("golden status-v2 fixtures match the normative schema and contain no v1 contract", () => {
  const schema = JSON.parse(readFileSync(resolve("oms.status.schema.json"), "utf8"));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  const fixtureRoot = resolve("tests", "fixtures", "status-v2");
  const fixtures = readdirSync(fixtureRoot).filter((name) => name.endsWith(".json")).sort();
  assert.deepEqual(fixtures, ["submodule.json", "worktree.json"]);
  for (const name of fixtures) {
    const source = readFileSync(join(fixtureRoot, name), "utf8");
    const fixture = JSON.parse(source);
    assert.equal(fixture.schemaVersion, 2, name);
    assert.equal(validate(fixture), true, `${name}: ${JSON.stringify(validate.errors)}`);
    assert.doesNotMatch(source, /"schemaVersion"\s*:\s*1\b/, name);
  }
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
    "currentTarget",
    "currentWorktree",
    "errors",
    "mode",
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

test("worktree status v2 reports plain-directory current context and validates against its schema", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const checkout = join(cwd, "oms", "api", "main");
  const data = statusJson(checkout);
  assert.equal(data.schemaVersion, 2);
  assert.equal(data.mode, "worktree");
  assert.equal(data.currentAlias, "api");
  assert.equal(data.currentWorktree, "main");
  assert.equal(data.currentTarget, "api/main");
  assert.equal(data.root, null);
  assert.equal(data.repos[0].mode, "worktree");
  assert.equal(data.repos[0].worktrees[0].target, "api/main");
  assert.equal(data.repos[0].worktrees[0].relativePath, "oms/api/main");
  assert.equal("pin" in data.repos[0], false);
  const human = run(["status"], { cwd: checkout });
  assert.equal(human.status, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /api\/main\s+main/);
  const schema = JSON.parse(readFileSync(resolve("oms.status.schema.json"), "utf8"));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(data), true, JSON.stringify(validate.errors));
});

test("worktree status reports external checkouts and compound filters", () => {
  const bare = initBareUpstream({ branches: ["main", "external"] });
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const common = join(cwd, ".oms", "repos", "api.git");
  git(common, "branch", "external", "refs/remotes/origin/external");
  const external = tempWorkspace();
  git(common, "worktree", "add", external, "external");

  const all = statusJson(cwd);
  const outside = all.repos[0].worktrees.find((entry) => !entry.managed);
  assert.equal(outside.name, null);
  assert.equal(outside.target, null);
  assert.equal(outside.path, realpathSync(external));
  const schema = JSON.parse(readFileSync(resolve("oms.status.schema.json"), "utf8"));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(all), true, JSON.stringify(validate.errors));
  const filtered = statusJson(cwd, ["api/main"]);
  assert.equal(filtered.repos.length, 1);
  assert.deepEqual(filtered.repos[0].worktrees.map((entry) => entry.target), ["api/main"]);
  const invalid = run(["status", "api/missing", "--json"], { cwd });
  assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
  assert.equal(invalid.stdout, "");
});

test("submodule status rejects worktree compound filters before JSON output", () => {
  const { cwd } = workspaceWithApi();
  const result = run(["status", "api/main", "--json"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /not alias\/name targets/);
});

test("worktree status preserves empty repositories and surfaces partial worktree errors", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const checkout = join(cwd, "oms", "api", "main");
  rmSync(checkout, { recursive: true, force: true });
  const partial = statusJson(cwd, [], 2);
  assert.equal(partial.repos[0].worktrees[0].error, "worktree path is stale");
  assert.equal(partial.errors[0].scope, "worktree");

  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const empty = statusJson(cwd);
  assert.deepEqual(empty.repos[0].worktrees, []);
  const human = run(["status"], { cwd });
  assert.equal(human.status, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /api\s+\(no worktrees\)/);
});

test("nested worktree status reports enclosing root and excludes generated paths from counts", () => {
  const bare = initBareUpstream();
  const root = initGitWorkspace();
  const cwd = join(root, "nested");
  mkdirSync(cwd);
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  const before = gitOut(root, "status", "--porcelain").split("\n").filter(Boolean).length;
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const data = statusJson(cwd);
  assert.equal(data.root.path, realpathSync(root));
  assert.equal(data.root.relation, "ancestor");
  assert.equal(data.root.changes.untracked, before);
  assert.equal("submodulePointers" in data.root, false);
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
