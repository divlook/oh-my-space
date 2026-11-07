import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { testEnv, run, tempFixture, writeSources, git, configIdentity, initBareUpstream, initGitWorkspace, gitOut, sourceFor, workspaceWithApi, statusJson, sourcesFor, gitmodulesSectionCount } from "./helpers.js";

// chmod 0o000 is not enforced for root, so permission-denial cases cannot run there.
const skipUnreadable =
  typeof process.getuid === "function" && process.getuid() === 0
    ? { skip: "chmod 0o000 is not enforced when running as root" }
    : {};


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

test("push lazily creates the remote branch without staging the root pointer", () => {
  const { bare, cwd } = workspaceWithApi();

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

  const upstreamSha = gitOut(bare, "rev-parse", "refs/heads/feature/x");
  assert.equal(upstreamSha, localSha);

  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
  assert.match(output, /oms record api/);
});

test("push fails clearly when detached HEAD has no local branch at its commit", () => {
  const { cwd } = workspaceWithApi();
  const dir = join(cwd, "oms", "api");
  git(dir, "commit", "--allow-empty", "-m", "detached tip");
  git(dir, "checkout", "--detach");
  git(dir, "branch", "-f", "main", "HEAD^");

  const result = run(["push", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /detached HEAD/);
});

test("status reports branch, pin state, and dirtiness", () => {
  const { cwd } = workspaceWithApi();

  let result = run(["status"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /ALIAS\s+BRANCH\s+PIN/);
  assert.match(result.stdout, /api\s+main\s+ok/);

  writeFileSync(join(cwd, "oms", "api", "dirty.txt"), "x");
  result = run(["status", "api"], { cwd });
  assert.match(result.stdout, /api\s+main\s+\S+\s+yes/);
});

test("status --json keeps a recorded-but-uninitialized repo in inventory as uninit", () => {
  const { cwd } = workspaceWithApi();
  const clone = tempFixture("oms-clone-");
  execFileSync("git", ["clone", cwd, clone], { stdio: "ignore", env: testEnv });
  configIdentity(clone);
  const repo = statusJson(clone).repos[0];
  assert.equal(repo.initialized, false);
  assert.equal(repo.pin, "uninit");
  assert.equal(repo.branch, null);
  assert.equal(repo.ahead, null);
});

test("status --json fails before emitting JSON for an unknown alias", () => {
  const { cwd } = workspaceWithApi();
  const result = run(["status", "missing-alias", "--json"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Unknown alias/);
});

test("the topology commit default does not depend on stdin being a terminal", () => {
  const bare = initBareUpstream();

  const plain = initGitWorkspace();
  writeSources(plain, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd: plain }).status, 0);

  const flagged = initGitWorkspace();
  writeSources(flagged, sourceFor("api", bare));
  assert.equal(run(["sync", "api", "--commit"], { cwd: flagged }).status, 0);

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

test("sync --commit isolates unrelated staged root paths through the temporary index", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  writeFileSync(join(cwd, "keep.txt"), "x");
  git(cwd, "add", "keep.txt");

  const result = run(["sync", "api", "--commit"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
  const staged = gitOut(cwd, "diff", "--cached", "--name-only");
  assert.match(staged, /keep\.txt/);
  assert.doesNotMatch(staged, /\.gitmodules/);
  assert.doesNotMatch(staged, /oms\/api/);
  assert.doesNotMatch(gitOut(cwd, "show", "--stat", "--pretty=format:", "HEAD"), /keep\.txt/);
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

test("unsync --commit records pending removal left by an earlier no-commit unsync", () => {
  const { cwd } = workspaceWithApi();
  assert.equal(run(["unsync", "api", "--no-commit"], { cwd }).status, 0);
  assert.equal(existsSync(join(cwd, "oms", "api")), false);
  const before = Number(gitOut(cwd, "rev-list", "--count", "HEAD"));

  const result = run(["unsync", "api", "--commit"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): remove api submodule");
  assert.equal(Number(gitOut(cwd, "rev-list", "--count", "HEAD")), before + 1);
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

test("unsync refuses and preserves a non-submodule path occupying the alias", () => {
  const { cwd } = workspaceWithApi();
  assert.equal(run(["unsync", "api"], { cwd }).status, 0);
  mkdirSync(join(cwd, "oms", "api"), { recursive: true });
  writeFileSync(join(cwd, "oms", "api", "file.txt"), "not a submodule");

  const result = run(["unsync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /occupied by a non-submodule/);
  assert.equal(readFileSync(join(cwd, "oms", "api", "file.txt"), "utf8"), "not a submodule");
  assert.doesNotMatch(output, /api: unsynced/);
  assert.doesNotMatch(output, /uncommitted or untracked changes/);
});

test("sync fresh add fails when oms/<alias> is unreadable", skipUnreadable, () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
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

test("pull advances the submodule branch without staging and hints record", () => {
  const { cwd, bare } = workspaceWithApi();
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
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
  assert.match(output, /oms record api/);
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

  writeFileSync(join(cwd, "oms", "web", ".DS_Store"), "x");

  const result = run(["unsync", "api", "web", "docs"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /Not unsynced:.*web/);
  assert.equal(existsSync(join(cwd, "oms", "web")), true);
  assert.equal(existsSync(join(cwd, "oms", "api")), false);
  assert.equal(existsSync(join(cwd, "oms", "docs")), false);
  assert.equal(gitmodulesSectionCount(cwd), 1, "only web's section should remain");
  assert.match(readFileSync(join(cwd, ".gitmodules"), "utf8"), /oms\/web/);
  assert.doesNotMatch(readFileSync(join(cwd, ".gitmodules"), "utf8"), /oms\/api|oms\/docs/);
});

test("sync creates a missing baseline at detached HEAD", () => {
  const { cwd, wt } = workspaceWithApi();
  const head = gitOut(wt, "rev-parse", "HEAD");
  git(wt, "checkout", "--detach");
  git(wt, "branch", "-D", "main");

  const result = run(["sync", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(wt, "branch", "--show-current"), "main");
  assert.equal(gitOut(wt, "rev-parse", "HEAD"), head);
  assert.equal(gitOut(wt, "rev-parse", "main"), head);
});

test("sync reports an attachment Git failure and preserves the detached commit", () => {
  const { cwd, wt } = workspaceWithApi();
  const pin = gitOut(cwd, "rev-parse", ":oms/api");
  git(wt, "checkout", "--detach");

  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const stubDir = tempFixture("oms-attach-failure-");
  const stubGit = join(stubDir, "git");
  writeFileSync(
    stubGit,
    `#!/usr/bin/env bash\nif [ "$1" = "switch" ] && [ "$2" = "main" ]; then echo "simulated attach failure" >&2; exit 93; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
  );
  chmodSync(stubGit, 0o755);

  const result = run(["sync", "api"], {
    cwd,
    env: { ...testEnv, PATH: `${stubDir}${delimiter}${testEnv.PATH}` },
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /simulated attach failure/);
  assert.match(output, /Repository state was preserved/);
  assert.equal(gitOut(wt, "rev-parse", "HEAD"), pin);
  assert.equal(gitOut(wt, "branch", "--show-current"), "");
  assert.equal(gitOut(cwd, "rev-parse", ":oms/api"), pin);
});
