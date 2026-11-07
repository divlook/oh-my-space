import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { testEnv, run, queueEnv, writeSources, git, initBareUpstream, initGitWorkspace, gitOut, sourceFor, workspaceWithApi, statusJson, workspaceCloneWithDriftedBaseline, sourcesFor, gitmodulesSectionCount } from "./helpers.js";

// chmod 0o000 is not enforced for root, so permission-denial cases cannot run there.
const skipUnreadable =
  typeof process.getuid === "function" && process.getuid() === 0
    ? { skip: "chmod 0o000 is not enforced when running as root" }
    : {};

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

test("switch onto an existing local branch just switches", () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  assert.equal(run(["branch", "checkout", "api", "dev"], { cwd }).status, 0);
  assert.equal(run(["branch", "switch", "api", "main"], { cwd }).status, 0);

  const sw = run(["branch", "switch", "api", "dev"], { cwd });
  assert.equal(sw.status, 0, sw.stdout + sw.stderr);
  assert.equal(gitOut(join(cwd, "oms", "api"), "branch", "--show-current"), "dev");
});

test("switch and checkout error without hanging when args are omitted in a non-TTY", () => {
  const { cwd } = workspaceWithApi();

  const noAlias = run(["branch", "switch"], { cwd });
  assert.equal(noAlias.status, 1, noAlias.stdout + noAlias.stderr);
  assert.match(noAlias.stdout + noAlias.stderr, /not a TTY/);

  const noBranchSwitch = run(["branch", "switch", "api"], { cwd });
  assert.equal(noBranchSwitch.status, 1, noBranchSwitch.stdout + noBranchSwitch.stderr);
  assert.match(noBranchSwitch.stdout + noBranchSwitch.stderr, /not a TTY/);

  const noBranchCheckout = run(["branch", "checkout", "api"], { cwd });
  assert.equal(noBranchCheckout.status, 1, noBranchCheckout.stdout + noBranchCheckout.stderr);
  assert.match(noBranchCheckout.stdout + noBranchCheckout.stderr, /not a TTY/);
});

test("push --record is unsupported and fails before pushing", () => {
  const { cwd } = workspaceWithApi();

  const result = run(["push", "api", "--record"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /not supported/);
  assert.match(output, /oms record api/);
});

test("pull --ff-only succeeds on the submodule's branch", () => {
  const { cwd } = workspaceWithApi();

  const result = run(["pull", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /pulled/);
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

test("status represents a conflicted root gitlink as conflict and still exits 0 for --json", () => {
  const { cwd } = workspaceWithApi();
  const wt = join(cwd, "oms", "api");
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

  const m = spawnSync("git", ["merge", "x"], { cwd, encoding: "utf8", env: testEnv });
  assert.notEqual(m.status, 0, "merge should conflict on the gitlink");

  const data = statusJson(cwd);
  assert.equal(data.repos[0].pin, "conflict");
  assert.deepEqual(data.root.submodulePointers.conflict, ["api"]);

  const table = run(["status"], { cwd });
  assert.match(table.stdout, /api\s+\S*\s*conflict/);
});

test("sync --commit creates a single-alias add topology commit", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));

  const result = run(["sync", "api", "--commit"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
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

test("sync --commit records pending add topology left by an earlier no-commit sync", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api", "--no-commit"], { cwd }).status, 0);
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
  const before = Number(gitOut(cwd, "rev-list", "--count", "HEAD"));

  const result = run(["sync", "api", "--commit"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
  assert.equal(Number(gitOut(cwd, "rev-list", "--count", "HEAD")), before + 1);
});

test("guarded multiselect drives an omitted selection and fails closed when malformed", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor([{ alias: "api", bare: a }, { alias: "web", bare: b }]));

  const picked = run(["sync"], { cwd, env: queueEnv([{ type: "multiselect", values: ["api"] }]) });
  assert.equal(picked.status, 0, picked.stdout + picked.stderr);
  assert.equal(existsSync(join(cwd, "oms", "api")), true);
  assert.equal(existsSync(join(cwd, "oms", "web")), false);

  const malformed = run(["sync"], { cwd, env: queueEnv([{ type: "multiselect", values: ["api", 7] }]) });
  assert.equal(malformed.status, 1, malformed.stdout + malformed.stderr);
  assert.match(malformed.stdout + malformed.stderr, /must be an array of strings/);

  const wrongType = run(["sync"], { cwd, env: queueEnv([{ type: "select", value: "api" }]) });
  assert.equal(wrongType.status, 1, wrongType.stdout + wrongType.stderr);
});

test("unsync --commit creates a removal topology commit", () => {
  const { cwd } = workspaceWithApi();
  const result = run(["unsync", "api", "--commit"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): remove api submodule");
  assert.equal(existsSync(join(cwd, "oms", "api")), false);
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

test("sync preserves a recorded pointer when the cloned baseline has advanced", () => {
  const { alias, bare, cwd, pin, tip, wt } = workspaceCloneWithDriftedBaseline();

  const result = run(["sync", alias], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.equal(gitOut(wt, "rev-parse", "HEAD"), pin);
  assert.equal(gitOut(wt, "branch", "--show-current"), "");
  assert.equal(gitOut(cwd, "rev-parse", `:oms/${alias}`), pin);
  assert.equal(gitOut(cwd, "status", "--porcelain"), "");
  assert.match(output, new RegExp(pin.slice(0, 7)));
  assert.match(output, new RegExp(tip.slice(0, 7)));
  assert.match(output, new RegExp(`oms branch switch ${alias} main`));
  assert.match(output, new RegExp(`oms pull ${alias}`));
  assert.match(output, new RegExp(`${alias}: initialized`));
  assert.doesNotMatch(output, /initialized \(branch=/);
  assert.doesNotMatch(output, new RegExp(bare.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")));
});

test("sync does not disturb an already-attached working branch", () => {
  const { cwd, wt } = workspaceWithApi();
  git(wt, "checkout", "-b", "work");
  const head = gitOut(wt, "rev-parse", "HEAD");

  const result = run(["sync", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(wt, "branch", "--show-current"), "work");
  assert.equal(gitOut(wt, "rev-parse", "HEAD"), head);
});

test("sync update preserves detached HEAD when the local baseline diverged", () => {
  const { alias, cwd, pin, wt } = workspaceCloneWithDriftedBaseline();
  git(cwd, "submodule", "update", "--init", "--", `oms/${alias}`);

  const result = run(["sync", alias], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /updated/);
  assert.match(output, /kept detached HEAD at [0-9a-f]{7} because baseline "main"/);
  assert.equal(gitOut(wt, "rev-parse", "HEAD"), pin);
  assert.equal(gitOut(wt, "branch", "--show-current"), "");
  assert.equal(gitOut(cwd, "status", "--porcelain"), "");
});
