import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { cloneSource } from "../../scripts/lib/clone-source.js";
import { convertLocalSource } from "../../scripts/lib/migration-local.js";
import { planMigration } from "../../scripts/lib/migration-plan.js";
import { inspectSourceCheckout, openSourceWorkspace } from "../../scripts/lib/source-checkout.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "protocol.file.allow=always", "-c", "user.name=Test", "-c", "user.email=test@example.test", ...args], { encoding: "utf8", stdio: "pipe" }).trim();
}

function temporaryDirectory(t: TestContext): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "oms-migration-safety-")));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function init(path: string): string {
  mkdirSync(path);
  git(path, "init", "-b", "main");
  git(path, "commit", "--allow-empty", "-m", "seed");
  return path;
}

function legacyWorkspace(scratch: string, origin: string, aliases: string[]) {
  const root = init(join(scratch, "root"));
  const repos = aliases.map((alias) => ({ alias, remotes: { origin } }));
  writeFileSync(join(root, "oms.yaml"), JSON.stringify({ repos }));
  for (const alias of aliases) git(root, "submodule", "add", origin, `oms/${alias}`);
  git(root, "add", ".");
  git(root, "commit", "-m", "legacy sources");
  return { root, repos };
}

function migrate(cwd: string, interruptAfterMove = false) {
  const migrationModule = new URL("../../scripts/lib/migrate-source.js", import.meta.url).href;
  const gitModule = new URL("../../scripts/lib/git.js", import.meta.url).href;
  const child = `
    import { runMigrate } from ${JSON.stringify(migrationModule)};
    import { productionGitRunner } from ${JSON.stringify(gitModule)};
    const git = (cwd, args, ...options) => {
      if (${interruptAfterMove} && args.includes("--unset") && args.includes("core.worktree")) process.kill(process.pid, "SIGKILL");
      return productionGitRunner(cwd, args, ...options);
    };
    process.exitCode = await runMigrate([], { yes: true }, git);
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", child], { cwd, encoding: "utf8" });
}

test("linked root migration and recovery use only that worktree's legacy Git data", (t) => {
  const scratch = temporaryDirectory(t);
  const origin = init(join(scratch, "origin"));
  const { root, repos } = legacyWorkspace(scratch, origin, ["api"]);
  const mainSource = join(root, "oms/api");
  git(mainSource, "commit", "--allow-empty", "-m", "main-root-only source commit");
  const mainHead = git(mainSource, "rev-parse", "HEAD");
  git(root, "submodule", "deinit", "--force", "oms/api");
  const mainData = git(root, "rev-parse", "--path-format=absolute", "--git-path", "modules/oms/api");
  const mainConfig = readFileSync(join(mainData, "config"));

  const linked = join(scratch, "linked");
  git(root, "worktree", "add", "-b", "linked", linked);
  const workspace = openSourceWorkspace(linked);
  const source = join(linked, "oms/api");
  const linkedData = git(linked, "rev-parse", "--path-format=absolute", "--git-path", "modules/oms/api");
  assert.equal(linkedData, join(workspace.gitDir, "modules/oms/api"));
  assert.notEqual(linkedData, mainData);
  const uninitialized = planMigration(workspace, repos, false);
  assert.deepEqual(uninitialized.blockers, []);
  assert.deepEqual(uninitialized.sources.map(({ gitDir }) => gitDir), [null]);

  git(linked, "submodule", "update", "--init", "--", "oms/api");
  const branch = "linked-topic\u00a0";
  git(source, "switch", "-c", branch);
  git(source, "commit", "--allow-empty", "-m", "linked-root-only source commit");
  const linkedHead = git(source, "rev-parse", "HEAD");
  const plan = planMigration(workspace, repos, false);
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.sources.map(({ gitDir }) => gitDir), [linkedData]);
  assert.equal(plan.sources[0].sourceBranch, `refs/heads/${branch}`);

  const journal = join(workspace.gitDir, "oms/source-migration.json");
  const interrupted = migrate(linked, true);
  assert.equal(interrupted.signal, "SIGKILL", interrupted.stdout + interrupted.stderr);
  assert.ok(existsSync(journal));
  const resumed = migrate(linked);
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.equal(existsSync(journal), false);
  assert.equal(existsSync(linkedData), false);
  assert.equal(git(source, "rev-parse", "HEAD"), linkedHead);
  assert.equal(readFileSync(join(source, ".git/HEAD"), "utf8"), `ref: refs/heads/${branch}\n`);
  assert.equal(git(root, `--git-dir=${mainData}`, "rev-parse", "HEAD"), mainHead);
  assert.deepEqual(readFileSync(join(mainData, "config")), mainConfig);
  assert.match(git(root, "ls-files", "--stage", "oms/api"), /^160000 /);

  git(linked, "add", "-A");
  git(linked, "commit", "-m", "accept migration");
  assert.equal(inspectSourceCheckout(workspace, repos[0]).kind, "ready");
});

test("migration does not delete shared submodule configuration used by another root worktree", (t) => {
  const scratch = temporaryDirectory(t);
  const origin = init(join(scratch, "origin"));
  const { root, repos } = legacyWorkspace(scratch, origin, ["api"]);
  const linked = join(scratch, "linked");
  git(root, "worktree", "add", "-b", "linked", linked);
  git(linked, "submodule", "update", "--init", "--", "oms/api");
  git(root, "config", "--local", "submodule.oms/api.update", "merge");
  const workspace = openSourceWorkspace(linked);
  const source = join(linked, "oms/api");
  const mainSource = join(root, "oms/api");
  const link = readFileSync(join(source, ".git"));
  const mainLink = readFileSync(join(mainSource, ".git"));
  const config = readFileSync(join(workspace.commonDir, "config"));
  const refused = migrate(linked);
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.match(refused.stdout + refused.stderr, /oms\/api: root worktree .* still uses the shared submodule registration/);
  assert.equal(existsSync(join(workspace.gitDir, "oms/source-migration.json")), false);
  assert.deepEqual(readFileSync(join(workspace.commonDir, "config")), config);
  assert.deepEqual(readFileSync(join(mainSource, ".git")), mainLink);
  assert.deepEqual(readFileSync(join(source, ".git")), link);

  const converted = join(scratch, "converted");
  git(root, "worktree", "add", "-b", "converted", converted);
  git(converted, "update-index", "--force-remove", "oms/api");
  rmSync(join(converted, "oms/api"), { recursive: true });
  git(converted, "rm", ".gitmodules");
  writeFileSync(join(converted, ".gitignore"), "/oms/api/\n");
  git(converted, "add", ".gitignore");
  git(converted, "commit", "-m", "receive independent source declaration");
  const convertedWorkspace = openSourceWorkspace(converted);
  assert.equal(cloneSource(convertedWorkspace, repos[0]), "cloned");
  assert.equal(inspectSourceCheckout(convertedWorkspace, repos[0]).kind, "ready");
  assert.deepEqual(readFileSync(join(workspace.commonDir, "config")), config);
  assert.deepEqual(readFileSync(join(mainSource, ".git")), mainLink);

  // Leave the main worktree's data and shared config in place, but detach its checkout.
  rmSync(join(mainSource, ".git"));
  const interrupted = migrate(linked, true);
  assert.equal(interrupted.signal, "SIGKILL", interrupted.stdout + interrupted.stderr);
  writeFileSync(join(mainSource, ".git"), mainLink);
  const paused = migrate(linked);
  assert.equal(paused.status, 2, paused.stdout + paused.stderr);
  assert.match(paused.stdout + paused.stderr, /still uses the shared submodule registration/);
  assert.ok(existsSync(join(workspace.gitDir, "oms/source-migration.json")));
  assert.deepEqual(readFileSync(join(workspace.commonDir, "config")), config);
  assert.equal(git(mainSource, "rev-parse", "HEAD"), git(origin, "rev-parse", "HEAD"));
});

test("migration blocks before relocating initialized nested submodule Git data", (t) => {
  const scratch = temporaryDirectory(t);
  const nestedOrigin = init(join(scratch, "nested-origin"));
  const origin = init(join(scratch, "origin"));
  git(origin, "submodule", "add", nestedOrigin, "nested");
  git(origin, "commit", "-am", "include nested submodule");
  const { root, repos } = legacyWorkspace(scratch, origin, ["api"]);
  const workspace = openSourceWorkspace(root);
  const source = join(root, "oms/api");
  const nested = join(source, "nested");
  const before = planMigration(workspace, repos, false);
  assert.deepEqual(before.blockers, []);
  assert.equal(before.sources.length, 1);

  git(source, "submodule", "update", "--init", "--", "nested");
  const outerLink = readFileSync(join(source, ".git"));
  const nestedLink = readFileSync(join(nested, ".git"));
  const nestedHead = git(nested, "rev-parse", "HEAD");
  const blocker = /nested submodule Git data cannot be relocated safely/;
  const plan = planMigration(workspace, repos, false);
  assert.equal(plan.sources.length, 0);
  assert.match(plan.blockers.join("\n"), blocker);
  assert.throws(() => convertLocalSource(workspace, before.sources[0]), blocker);
  assert.deepEqual(readFileSync(join(source, ".git")), outerLink);
  assert.deepEqual(readFileSync(join(nested, ".git")), nestedLink);
  assert.equal(git(nested, "rev-parse", "HEAD"), nestedHead);
});

test("migration resume preserves a worktree registered after the journal was written", (t) => {
  const scratch = temporaryDirectory(t);
  const origin = init(join(scratch, "origin"));
  const { root } = legacyWorkspace(scratch, origin, ["api", "worker"]);
  const journal = join(root, ".git/oms/source-migration.json");
  const source = join(root, "oms/worker");
  const interrupted = migrate(root, true);
  assert.equal(interrupted.signal, "SIGKILL", interrupted.stdout + interrupted.stderr);
  assert.ok(lstatSync(join(root, "oms/api/.git")).isDirectory());
  const snapshot = readFileSync(journal);
  const sourceLink = readFileSync(join(source, ".git"));
  const extra = join(scratch, "added-after-interruption");
  git(source, "worktree", "add", "--detach", extra);
  writeFileSync(join(extra, "local"), "preserve this");
  const extraLink = readFileSync(join(extra, ".git"));
  const extraHead = git(extra, "rev-parse", "HEAD");

  const refused = migrate(root);
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.match(refused.stdout + refused.stderr, /linked worktree inventory differs from the migration plan/);
  assert.deepEqual(readFileSync(journal), snapshot);
  assert.deepEqual(readFileSync(join(source, ".git")), sourceLink);
  assert.deepEqual(readFileSync(join(extra, ".git")), extraLink);
  assert.equal(git(extra, "rev-parse", "HEAD"), extraHead);
  assert.equal(git(extra, "rev-parse", "--path-format=absolute", "--git-common-dir"), join(root, ".git/modules/oms/worker"));
  assert.equal(readFileSync(join(extra, "local"), "utf8"), "preserve this");
  assert.match(git(root, "ls-files", "--stage", "oms/worker"), /^160000 /);
});
