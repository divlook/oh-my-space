import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { git, gitOut, initBareUpstream, initGitWorkspace, run, sourceFor, sourcesFor, tempFixture, testEnv, writeSources } from "./helpers.js";

function legacyWorkspace(root, origin, manifest) {
  writeSources(root, manifest);
  git(root, "submodule", "add", `file://${origin}`, "oms/api");
  git(root, "add", "oms.yaml", ".gitmodules", "oms/api");
  git(root, "commit", "-m", "legacy workspace");
}

test("built CLI resumes migration after process loss at Git data and index boundaries", { skip: process.platform === "win32" }, () => {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const shim = tempFixture("oms-migrate-git-");
  const path = join(shim, "git");
  writeFileSync(path, `#!/usr/bin/env bash
case "$OMS_MIGRATION_TEST_POINT:$*" in
  relocation:*'--unset core.worktree'|repair:'worktree repair '*|root-index:*'--force-remove'*)
    kill -KILL "$PPID"
    exit 86
    ;;
esac
exec ${JSON.stringify(realGit)} "$@"
`);
  chmodSync(path, 0o755);
  const origin = initBareUpstream();
  for (const stage of ["relocation", "repair", "root-index"]) {
    const root = realpathSync(initGitWorkspace());
    legacyWorkspace(root, origin, sourceFor("api", origin));
    const api = join(root, "oms/api");
    const tree = realpathSync(tempFixture("oms-recovery-tree-"));
    git(api, "worktree", "add", "-b", "task", tree);
    writeFileSync(join(tree, "local.txt"), "retain working files");
    const rootHead = gitOut(root, "rev-parse", "HEAD");
    const journal = join(root, ".git/oms/source-migration.json");
    const interrupted = run(["migrate", "--yes"], {
      cwd: root,
      env: { ...testEnv, PATH: `${shim}:${testEnv.PATH}`, OMS_MIGRATION_TEST_POINT: stage },
    });
    assert.equal(interrupted.signal, "SIGKILL", interrupted.stdout + interrupted.stderr);
    assert.ok(existsSync(journal));
    assert.ok(existsSync(join(api, ".git/HEAD")));
    const blockedUse = run(["clone", "api"], { cwd: root });
    assert.equal(blockedUse.status, 2, blockedUse.stdout + blockedUse.stderr);
    assert.match(blockedUse.stdout + blockedUse.stderr, /migration is incomplete/);
    const preview = run(["migrate", "--dry-run"], { cwd: root });
    assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    assert.match(preview.stdout + preview.stderr, /Interrupted migration found/);
    if (stage === "root-index") {
      const ignore = join(root, ".gitignore");
      const before = readFileSync(ignore);
      writeFileSync(ignore, "# unexpected edit\n");
      const failed = run(["migrate", "--yes"], { cwd: root });
      assert.equal(failed.status, 2, failed.stdout + failed.stderr);
      assert.match(failed.stdout + failed.stderr, /changed since preview/);
      assert.ok(existsSync(journal));
      assert.equal(readFileSync(ignore, "utf8"), "# unexpected edit\n");
      writeFileSync(ignore, before);
    }
    const resumed = run(["migrate", "--yes"], { cwd: root });
    assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
    assert.equal(existsSync(journal), false);
    assert.equal(gitOut(root, "rev-parse", "HEAD"), rootHead);
    assert.equal(gitOut(root, "ls-files", "oms/api"), "");
    assert.equal(gitOut(tree, "rev-parse", "--path-format=absolute", "--git-common-dir"), join(api, ".git"));
    assert.equal(readFileSync(join(tree, "local.txt"), "utf8"), "retain working files");
  }
});

test("built CLI migrates two workspaces, clones missing sources and removes only approved local data", () => {
  const root = realpathSync(initGitWorkspace());
  const origin = initBareUpstream();
  const second = tempFixture("oms-migration-second-");
  legacyWorkspace(root, origin, sourcesFor([{ alias: "api", bare: origin }, { alias: "extra", bare: origin }]));
  git(root, "clone", root, second);
  git(second, "submodule", "update", "--init", "--", "oms/api");
  const firstApi = join(root, "oms/api");
  const secondApi = join(second, "oms/api");
  git(firstApi, "switch", "-c", "first-only");
  writeFileSync(join(firstApi, "untracked.txt"), "first local action");
  git(secondApi, "branch", "second-only");
  git(secondApi, "worktree", "add", "-b", "second-task", join(second, ".oms-tree/api/second-task"));
  const task = join(second, ".oms-tree/api/second-task");
  writeFileSync(join(task, "untracked.txt"), "second local action");
  const beforeMigration = gitOut(root, "ls-files", "--stage");
  const partial = run(["migrate", "api", "--yes"], { cwd: root });
  assert.equal(partial.status, 1, partial.stdout + partial.stderr);
  assert.match(partial.stdout + partial.stderr, /does not accept aliases/);
  assert.equal(gitOut(root, "ls-files", "--stage"), beforeMigration);
  assert.equal(existsSync(join(root, ".git/oms/source-migration.json")), false);
  assert.equal(run(["migrate", "--dry-run"], { cwd: second }).status, 0);
  const converted = run(["migrate", "--yes"], { cwd: root });
  assert.equal(converted.status, 0, converted.stdout + converted.stderr);
  git(root, "add", ".gitignore", ".gitmodules", "oms.yaml");
  git(root, "commit", "-m", "share conversion");
  const shared = gitOut(root, "rev-parse", "HEAD");
  git(second, "pull", "--ff-only");
  const migrated = run(["migrate", "--yes"], { cwd: second });
  assert.equal(migrated.status, 0, migrated.stdout + migrated.stderr);
  assert.equal(gitOut(second, "rev-parse", "HEAD"), shared);
  assert.equal(gitOut(firstApi, "branch", "--show-current"), "first-only");
  assert.equal(readFileSync(join(firstApi, "untracked.txt"), "utf8"), "first local action");
  assert.equal(gitOut(task, "branch", "--show-current"), "second-task");
  assert.equal(readFileSync(join(task, "untracked.txt"), "utf8"), "second local action");
  assert.equal(gitOut(secondApi, "rev-parse", "refs/heads/second-only"), gitOut(origin, "rev-parse", "main"));
  const cloned = run(["clone", "extra"], { cwd: second });
  assert.equal(cloned.status, 0, cloned.stdout + cloned.stderr);
  const extra = join(second, "oms/extra");
  assert.ok(existsSync(join(extra, ".git/HEAD")));
  const blocked = run(["remove", "extra"], { cwd: second });
  assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
  assert.ok(existsSync(extra));
  const removed = run(["remove", "extra", "--yes"], { cwd: second });
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.equal(existsSync(extra), false);
  assert.equal(gitOut(second, "rev-parse", "HEAD"), shared);
  assert.equal(gitOut(second, "ls-files", "oms/api", "oms/extra"), "");
  assert.equal(gitOut(second, "--no-optional-locks", "status", "--porcelain", "--untracked-files=no"), "");
});
