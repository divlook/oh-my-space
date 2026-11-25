import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cloneSource } from "../../scripts/lib/clone-source.js";
import { convertLocalSource } from "../../scripts/lib/migration-local.js";
import { planMigration } from "../../scripts/lib/migration-plan.js";
import { applyMigrationRoot, planMigrationRoot, verifyMigrationRoot } from "../../scripts/lib/migration-root.js";
import { openSourceWorkspace } from "../../scripts/lib/source-checkout.js";
import { pathToFileURL } from "node:url";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "protocol.file.allow=always", "-c", "user.name=Test", "-c", "user.email=test@example.test", ...args], { stdio: "pipe" }).toString().trim();
}

test("local migration preserves staged and unpublished state and repairs managed and external links", (t) => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "oms-migration-test-")));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const root = join(scratch, "root");
  const origin = join(scratch, "origin");
  for (const path of [root, origin]) {
    mkdirSync(path);
    git(path, "init", "-b", "main");
  }
  writeFileSync(join(origin, "file"), "base");
  git(origin, "add", ".");
  git(origin, "commit", "-m", "base");
  const repos = ["api", "standalone", "retained"].map((alias) => ({ alias, remotes: { origin } }));
  writeFileSync(join(root, "oms.yaml"), JSON.stringify({ repos, autoCommitRegistration: true }));
  for (const { alias } of repos) git(root, "submodule", "add", origin, `oms/${alias}`);
  git(root, "add", ".");
  git(root, "commit", "-m", "legacy workspace");
  const workspace = openSourceWorkspace(root);
  const api = join(root, "oms/api");
  const standalone = join(root, "oms/standalone");
  const retained = join(root, "oms/retained");
  rmSync(join(standalone, ".git"));
  renameSync(join(workspace.commonDir, "modules/oms/standalone"), join(standalone, ".git"));
  git(root, "config", "--file", join(standalone, ".git/config"), "--unset", "core.worktree");
  writeFileSync(join(retained, "file"), "staged retained");
  git(retained, "add", "file");
  writeFileSync(join(retained, "lost"), "uncommitted and then removed");
  rmSync(retained, { recursive: true });

  git(api, "switch", "--detach");
  git(api, "commit", "--allow-empty", "-m", "unpublished");
  writeFileSync(join(api, "file"), "stash");
  git(api, "stash", "push");
  writeFileSync(join(api, "file"), "staged");
  git(api, "add", "file");
  writeFileSync(join(api, "file"), "working");
  writeFileSync(join(api, "untracked"), "local");
  const managed = join(root, ".oms-tree/api/task");
  const external = join(scratch, "external");
  mkdirSync(join(root, ".oms-tree/api"), { recursive: true });
  git(api, "worktree", "add", "-b", "task", managed);
  git(api, "worktree", "add", "--detach", external);
  for (const path of [managed, external]) {
    writeFileSync(join(path, "extra"), "task data");
    git(path, "add", "extra");
  }
  const snapshot = (path: string) => ({
    head: git(path, "rev-parse", "HEAD"),
    refs: git(path, "show-ref"),
    status: git(path, "--no-optional-locks", "status", "--porcelain"),
    index: readFileSync(join(git(path, "rev-parse", "--absolute-git-dir"), "index")),
  });
  const snapshots = [api, managed, external, standalone].map(snapshot);
  const plan = planMigration(workspace, repos, true);
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.sources.map(({ recreateFiles }) => recreateFiles), [false, false, true]);
  for (const source of plan.sources) convertLocalSource(workspace, source);
  assert.deepEqual([api, managed, external, standalone].map(snapshot), snapshots);
  for (const path of [managed, external]) {
    assert.equal(git(path, "rev-parse", "--path-format=absolute", "--git-common-dir"), join(api, ".git"));
  }
  assert.equal(readFileSync(join(api, "file"), "utf8"), "working");
  assert.equal(readFileSync(join(api, "untracked"), "utf8"), "local");
  assert.match(git(api, "stash", "list"), /stash@\{0\}/);
  assert.equal(readFileSync(join(retained, "file"), "utf8"), "staged retained");
  assert.equal(existsSync(join(retained, "lost")), false);
  for (const source of plan.sources) convertLocalSource(workspace, source);
  assert.deepEqual([api, managed, external, standalone].map(snapshot), snapshots);
});

test("root migration changes only owned registrations and a second workspace makes only local edits", (t) => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "oms-migration-root-")));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const root = join(scratch, "root");
  const origin = join(scratch, "origin");
  for (const path of [root, origin]) {
    mkdirSync(path);
    git(path, "init", "-b", "main");
  }
  writeFileSync(join(origin, "file"), "seed");
  git(origin, "add", ".");
  git(origin, "commit", "-m", "seed");
  const repos = ["api", "missing"].map((alias) => ({ alias, remotes: { origin } }));
  const manifest = `# root instructions stay here\nrepos:\n  - alias: api\n    remotes:\n      origin: ${origin}\n  - alias: missing\n    remotes:\n      origin: ${origin}\nautoCommitRegistration: true # old behavior\n`;
  writeFileSync(join(root, "oms.yaml"), manifest);
  git(root, "submodule", "add", origin, "oms/api");
  git(root, "submodule", "add", "--name", "unrelated", origin, "vendor/keep");
  git(root, "config", "-f", ".gitmodules", "submodule.oms/api.branch", "topic-\uFFFD");
  writeFileSync(join(root, "oms/AGENTS.md"), "instructions\n");
  writeFileSync(join(root, ".gitignore"), "# keep this rule\n/local.txt\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "legacy");
  const second = join(scratch, "second");
  git(scratch, "clone", root, second);
  git(second, "submodule", "update", "--init", "--", "oms/api");
  git(join(second, "oms/api"), "switch", "-c", "second-only");
  git(join(second, "oms/api"), "commit", "--allow-empty", "-m", "second only");
  const unpublished = git(join(second, "oms/api"), "rev-parse", "HEAD");
  const beforeUpdate = planMigration(openSourceWorkspace(second), repos, true);
  assert.deepEqual(beforeUpdate.blockers, []);
  assert.deepEqual(beforeUpdate.sources.map(({ repo }) => repo.alias), ["api"]);
  const backup = join(scratch, "second-only.bundle");
  git(join(second, "oms/api"), "bundle", "create", backup, "second-only");
  git(join(second, "oms/api"), "switch", "--detach", git(origin, "rev-parse", "HEAD"));
  git(second, "submodule", "deinit", "oms/api");
  rmSync(join(second, "oms/api"), { recursive: true });
  const nestedIgnore = join(second, "oms/.gitignore");
  writeFileSync(nestedIgnore, "!/api/\n");
  const beforePull = openSourceWorkspace(second);
  const retainedPlan = planMigration(beforePull, repos, true);
  assert.deepEqual(retainedPlan.blockers, []);
  assert.throws(() => planMigrationRoot(beforePull, retainedPlan), /oms\/\.gitignore contains an ignore exception for oms\/api/);
  assert.equal(existsSync(join(second, ".git/oms/source-migration.json")), false);
  assert.equal(existsSync(join(second, "oms/api")), false);
  rmSync(nestedIgnore);

  const partial = join(scratch, "partial");
  git(scratch, "clone", root, partial);
  git(partial, "submodule", "update", "--init", "--", "oms/api");
  git(partial, "update-index", "--force-remove", "oms/api");
  writeFileSync(join(partial, ".gitignore"), "/oms/api/\n");
  git(partial, "add", ".gitignore");
  git(partial, "commit", "-m", "remove gitlink but leave its registration");
  const stale = git(partial, "rev-parse", "HEAD");
  git(partial, "config", "-f", ".gitmodules", "--remove-section", "submodule.oms/api");
  const partialWs = openSourceWorkspace(partial);
  const registered = git(partial, "show", ":.gitmodules");
  const blocked = planMigration(partialWs, repos, true);
  assert.match(blocked.blockers.join("\n"), /api:.*\.gitmodules registration still exists in HEAD.*oms migrate --dry-run/);
  assert.equal(git(partial, "show", ":.gitmodules"), registered);
  assert.ok(existsSync(join(partialWs.gitDir, "modules/oms/api")));
  git(partial, "commit", "--only", "-m", "remove obsolete registration", "--", ".gitmodules");
  const retry = planMigration(partialWs, repos, true);
  assert.deepEqual(retry.blockers, []);
  assert.deepEqual(retry.sources.map(({ repo }) => repo.alias), ["api"]);
  assert.equal(git(partial, "config", "-f", ".gitmodules", "--get", "submodule.unrelated.path"), "vendor/keep");
  const clean = git(partial, "rev-parse", "HEAD");
  const merge = git(partial, "commit-tree", "HEAD^{tree}", "-p", stale, "-p", clean, "-m", "merge cleanup with conflicting registration state");
  git(partial, "switch", "--detach", merge);
  assert.match(planMigration(partialWs, repos, true).blockers.join("\n"), /api:.*historical merge parents disagree/);
  const kept = git(partial, "commit-tree", `${stale}^{tree}`, "-p", stale, "-p", clean, "-m", "merge retains the stale registration");
  const cleanup = git(partial, "commit-tree", `${clean}^{tree}`, "-p", kept, "-m", "remove registration after the merge");
  git(partial, "switch", "--detach", cleanup);
  assert.match(planMigration(partialWs, repos, true).blockers.join("\n"), /api:.*historical merge prevents verifying legacy ownership/);
  git(partial, "switch", "--detach", stale);
  writeFileSync(join(partial, "oms.yaml"), JSON.stringify({ repos: [{ alias: "api", remotes: { origin: `${origin}-different` } }] }));
  git(partial, "commit", "--only", "-m", "change the origin while the registration is stale", "--", "oms.yaml");
  writeFileSync(join(partial, "oms.yaml"), manifest);
  git(partial, "commit", "--only", "-m", "restore the declaration", "--", "oms.yaml");
  git(partial, "config", "-f", ".gitmodules", "--remove-section", "submodule.oms/api");
  git(partial, "commit", "--only", "-m", "remove registration after the declaration changed", "--", ".gitmodules");
  assert.match(planMigration(partialWs, repos, true).blockers.join("\n"), /api:.*historic origin differs/);
  const restored = git(partial, "commit-tree", `${stale}^{tree}`, "-p", clean, "-m", "restore obsolete registration");
  const removedAgain = git(partial, "commit-tree", `${clean}^{tree}`, "-p", restored, "-m", "remove restored registration");
  git(partial, "switch", "--detach", removedAgain);
  assert.match(planMigration(partialWs, repos, true).blockers.join("\n"), /api:.*registration was removed and restored/);

  writeFileSync(join(root, "staged.txt"), "preserve this staged entry");
  git(root, "add", "staged.txt");
  const staged = git(root, "ls-files", "--stage", "staged.txt", "vendor/keep", "oms/AGENTS.md");
  const previous = git(root, "rev-parse", "HEAD");
  const workspace = openSourceWorkspace(root);
  const gitmodules = join(root, ".gitmodules");
  const originalRegistration = readFileSync(gitmodules);
  git(root, "config", "-f", ".gitmodules", "submodule.oms/api.branch", "local-topic");
  const editedRegistration = readFileSync(gitmodules);
  assert.match(planMigration(workspace, repos, true).blockers.join("\n"), /api:.*overlapping changes/);
  assert.deepEqual(readFileSync(gitmodules), editedRegistration);
  git(root, "add", ".gitmodules");
  writeFileSync(gitmodules, originalRegistration);
  const stagedRegistration = git(root, "show", ":.gitmodules");
  assert.match(planMigration(workspace, repos, true).blockers.join("\n"), /api:.*overlapping changes/);
  assert.equal(git(root, "show", ":.gitmodules"), stagedRegistration);
  assert.match(stagedRegistration, /local-topic/);
  assert.equal(existsSync(join(workspace.gitDir, "oms/source-migration.json")), false);
  const legacyEncoding = Buffer.from(originalRegistration.toString("latin1").replace("topic-\xEF\xBF\xBD", "topic-\xE9"), "latin1");
  writeFileSync(gitmodules, legacyEncoding);
  git(root, "add", ".gitmodules");
  writeFileSync(gitmodules, originalRegistration);
  assert.match(planMigration(workspace, repos, true).blockers.join("\n"), /api:.*overlapping changes/);
  git(root, "config", "-f", ".gitmodules", "submodule.unrelated.branch", "vendor-topic");
  git(root, "add", ".gitmodules");
  const stagedVendorRegistration = git(root, "show", ":.gitmodules");
  git(root, "config", "-f", ".gitmodules", "submodule.unrelated.update", "merge");
  const plan = planMigration(workspace, repos, true);
  assert.deepEqual(plan.blockers, []);
  const patch = planMigrationRoot(workspace, plan);
  writeFileSync(join(root, ".gitignore"), "!/oms/api/\n");
  assert.throws(() => verifyMigrationRoot(workspace, patch, plan.sources, true), /changed since preview/);
  assert.ok(existsSync(join(workspace.commonDir, "modules/oms/api")));
  writeFileSync(join(root, ".gitignore"), "# keep this rule\n/local.txt\n");
  for (const source of plan.sources) convertLocalSource(workspace, source);
  applyMigrationRoot(workspace, patch, plan.sources);
  assert.deepEqual(git(root, "ls-files", "--stage", "staged.txt", "vendor/keep", "oms/AGENTS.md"), staged);
  assert.equal(git(root, "ls-files", "oms/api"), "");
  assert.equal(git(root, "rev-parse", "HEAD"), previous);
  assert.equal(git(root, "config", "-f", ".gitmodules", "--get", "submodule.unrelated.path"), "vendor/keep");
  assert.equal(git(root, "config", "-f", ".gitmodules", "--get", "submodule.unrelated.branch"), "vendor-topic");
  assert.equal(git(root, "config", "-f", ".gitmodules", "--get", "submodule.unrelated.update"), "merge");
  assert.equal(git(root, "show", ":.gitmodules"), stagedVendorRegistration);
  assert.match(readFileSync(join(root, "oms.yaml"), "utf8"), /# old behavior/);
  assert.doesNotMatch(readFileSync(join(root, "oms.yaml"), "utf8"), /autoCommitRegistration/);
  assert.match(readFileSync(join(root, ".gitignore"), "utf8"), /^# keep this rule\n\/local.txt\n\/oms\/api\/\n$/);
  assert.equal(readFileSync(join(root, "oms/AGENTS.md"), "utf8"), "instructions\n");
  assert.match(planMigration(workspace, repos, true).blockers.join("\n"), /api:.*pointer is still in HEAD but is missing from the index.*together with its \.gitmodules registration removal/);
  git(root, "restore", "--staged", "staged.txt");
  git(root, "add", "oms.yaml", ".gitignore", ".gitmodules");
  git(root, "commit", "-m", "share migration");

  git(second, "pull", "--ff-only");
  const secondWs = openSourceWorkspace(second);
  const secondPlan = planMigration(secondWs, repos, false);
  assert.deepEqual(secondPlan.blockers, []);
  assert.equal(secondPlan.sources.length, 1);
  const secondPatch = planMigrationRoot(secondWs, secondPlan);
  assert.deepEqual(secondPatch, { files: [], links: [] });
  const secondIgnore = join(second, ".gitignore");
  const savedIgnore = readFileSync(secondIgnore);
  writeFileSync(secondIgnore, "# local edit removed the shared ignore rule\n");
  assert.throws(() => planMigrationRoot(secondWs, secondPlan), /root ignore rules do not hide oms\/api/);
  assert.throws(() => verifyMigrationRoot(secondWs, secondPatch, secondPlan.sources, false), /root ignore rules do not hide oms\/api/);
  assert.ok(existsSync(join(secondWs.gitDir, "modules/oms/api")));
  assert.equal(existsSync(join(second, "oms/api")), false);
  writeFileSync(secondIgnore, savedIgnore);
  for (const source of secondPlan.sources) convertLocalSource(secondWs, source);
  applyMigrationRoot(secondWs, secondPatch, secondPlan.sources);
  assert.equal(git(second, "--no-optional-locks", "status", "--porcelain"), "");
  assert.equal(git(join(second, "oms/api"), "rev-parse", "refs/heads/second-only"), unpublished);
  assert.equal(cloneSource(secondWs, repos[1]), "cloned");
  assert.equal(git(second, "--no-optional-locks", "status", "--porcelain"), "");
  assert.equal(git(join(second, "oms/missing"), "rev-parse", "HEAD"), git(origin, "rev-parse", "HEAD"));
});

test("interrupted migration resumes at relocation, worktree repair, and root-index boundaries", (t) => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "oms-migration-recovery-")));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const origin = join(scratch, "origin-源");
  mkdirSync(origin);
  git(origin, "init", "-b", "main");
  writeFileSync(join(origin, "file"), "seed");
  git(origin, "add", ".");
  git(origin, "commit", "-m", "seed");
  const module = new URL("../../scripts/lib/migrate-source.js", import.meta.url).href;
  const gitModule = new URL("../../scripts/lib/git.js", import.meta.url).href;
  const child = `
    import { writeFileSync } from "node:fs";
    import { runMigrate } from ${JSON.stringify(module)};
    import { productionGitRunner } from ${JSON.stringify(gitModule)};
    const stage = process.env.MIGRATION_INTERRUPT;
    const run = (cwd, args, ...options) => {
      if ((stage === "relocation" && args.includes("--unset") && args.includes("core.worktree")) ||
          (stage === "repair" && args[0] === "worktree" && args[1] === "repair") ||
          (stage === "root-index" && args.includes("--force-remove"))) process.kill(process.pid, "SIGKILL");
      const result = productionGitRunner(cwd, args, ...options);
      if (result.success && args[0] === "update-ref" && args[1] === "refs/oms/source-migration-lock" && process.env.MIGRATION_NEW_MANIFEST) {
        writeFileSync("oms.yaml", process.env.MIGRATION_NEW_MANIFEST);
      }
      return result;
    };
    process.exitCode = await runMigrate([], { yes: process.env.MIGRATION_APPROVE === "1", dryRun: process.env.MIGRATION_PREVIEW === "1" }, run);
  `;
  for (const stage of ["relocation", "repair", "root-index"]) {
    const root = join(scratch, stage);
    mkdirSync(root);
    git(root, "init", "-b", "main");
    const manifest = {
      repos: [{ alias: "api", remotes: { origin } }],
      ...(stage !== "repair" && { autoCommitRegistration: false }),
    };
    writeFileSync(join(root, "oms.yaml"), JSON.stringify(manifest));
    git(root, "submodule", "add", origin, "oms/api");
    if (stage === "repair") writeFileSync(join(root, ".gitignore"), "/oms/api/\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "legacy");
    if (stage === "relocation") {
      git(root, "switch", "-c", "other");
      writeFileSync(join(root, "unrelated.txt"), "other\n");
      git(root, "add", "unrelated.txt");
      git(root, "commit", "-m", "other change");
      git(root, "switch", "main");
      writeFileSync(join(root, "unrelated.txt"), "main\n");
      git(root, "add", "unrelated.txt");
      git(root, "commit", "-m", "main change");
    }
    const api = join(root, "oms/api");
    const tree = join(scratch, `${stage}-worktree`);
    git(api, "worktree", "add", "-b", "task", tree);
    writeFileSync(join(tree, "extra"), "keep linked data");
    const journal = join(root, ".git/oms/source-migration.json");
    const cwd = pathToFileURL(`${root}/`);
    const run = (options: NodeJS.ProcessEnv) => spawnSync(process.execPath, ["--input-type=module", "-e", child], {
      cwd,
      env: { ...process.env, ...options },
      encoding: "utf8",
    });
    const head = git(root, "rev-parse", "HEAD");
    const gitlink = git(root, "ls-files", "--stage", "oms/api");
    if (stage === "relocation") {
      assert.throws(() => git(root, "merge", "--no-edit", "other"));
      assert.match(git(root, "ls-files", "--unmerged"), /unrelated\.txt/);
      const blocked = run({ MIGRATION_APPROVE: "1" });
      assert.equal(blocked.status, 2, blocked.stdout + blocked.stderr);
      assert.match(blocked.stdout + blocked.stderr, /root workspace has an active Git merge/);
      assert.equal(git(root, "ls-files", "--stage", "oms/api"), gitlink);
      assert.equal(existsSync(journal), false);
      git(root, "merge", "--abort");
    }
    const noConsent = run({});
    assert.equal(noConsent.status, 1, noConsent.stdout + noConsent.stderr);
    const declined = run({ OMS_TEST_MODE: "1", OMS_TEST_PROMPT_RESPONSES: '[{"type":"confirm","value":false}]' });
    assert.equal(declined.status, 1, declined.stdout + declined.stderr);
    assert.equal(existsSync(journal), false);
    assert.ok(existsSync(join(root, ".git/modules/oms/api")));
    const interrupted = run({ MIGRATION_APPROVE: "1", MIGRATION_INTERRUPT: stage });
    assert.equal(interrupted.signal, "SIGKILL", interrupted.stdout + interrupted.stderr);
    assert.ok(existsSync(journal));
    assert.ok(existsSync(join(api, ".git/HEAD")));
    const report = run({ MIGRATION_PREVIEW: "1" });
    assert.equal(report.status, 0, report.stdout + report.stderr);
    assert.match(report.stdout + report.stderr, /Interrupted migration found/);
    if (stage === "relocation") {
      const mergeHead = git(root, "rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD");
      writeFileSync(mergeHead, `${git(root, "rev-parse", "other")}\n`);
      const blocked = run({ MIGRATION_APPROVE: "1" });
      assert.equal(blocked.status, 2, blocked.stdout + blocked.stderr);
      assert.match(blocked.stdout + blocked.stderr, /root workspace has an active Git merge/);
      assert.equal(git(root, "ls-files", "--stage", "oms/api"), gitlink);
      assert.ok(existsSync(journal));
      rmSync(mergeHead);

      const gitmodules = join(root, ".gitmodules");
      const original = readFileSync(gitmodules);
      git(root, "config", "-f", ".gitmodules", "submodule.oms/api.branch", "paused-topic");
      git(root, "add", ".gitmodules");
      writeFileSync(gitmodules, original);
      const staged = git(root, "show", ":.gitmodules");
      const refused = run({ MIGRATION_APPROVE: "1" });
      assert.equal(refused.status, 2, refused.stdout + refused.stderr);
      assert.match(refused.stdout + refused.stderr, /staged .gitmodules registration changed for oms\/api/);
      assert.ok(existsSync(journal));
      assert.deepEqual(readFileSync(gitmodules), original);
      assert.equal(git(root, "show", ":.gitmodules"), staged);
      git(root, "config", "-f", ".gitmodules", "submodule.unrelated.branch", "vendor-topic");
      git(root, "add", ".gitmodules");
      writeFileSync(gitmodules, original);
    }
    if (stage === "repair") {
      const registration = readFileSync(join(root, ".gitmodules"));
      const changedManifest = run({
        OMS_TEST_MODE: "1",
        OMS_TEST_PROMPT_RESPONSES: '[{"type":"confirm","value":true}]',
        MIGRATION_NEW_MANIFEST: JSON.stringify({ repos: [{ ...manifest.repos[0], branch: "changed" }] }),
      });
      assert.equal(changedManifest.status, 2, changedManifest.stdout + changedManifest.stderr);
      assert.match(changedManifest.stdout + changedManifest.stderr, /declaration differs from the recorded migration/);
      assert.ok(existsSync(journal));
      assert.equal(git(root, "ls-files", "--stage", "oms/api"), gitlink);
      assert.deepEqual(readFileSync(join(root, ".gitmodules")), registration);
      writeFileSync(join(root, "oms.yaml"), JSON.stringify(manifest));

      const ignore = join(root, ".gitignore");
      writeFileSync(ignore, "# original ignore rule removed\n");
      const uncovered = run({ MIGRATION_APPROVE: "1" });
      assert.equal(uncovered.status, 2, uncovered.stdout + uncovered.stderr);
      assert.match(uncovered.stdout + uncovered.stderr, /root ignore rules do not hide oms\/api/);
      assert.ok(existsSync(journal));
      assert.equal(git(root, "ls-files", "--stage", "oms/api"), gitlink);
      assert.deepEqual(readFileSync(join(root, ".gitmodules")), registration);
      writeFileSync(ignore, "/oms/api/\n");
    }
    if (stage === "root-index") {
      const ignore = join(root, ".gitignore");
      const saved = readFileSync(ignore);
      writeFileSync(ignore, "# conflicting edit\n");
      const refused = run({ MIGRATION_APPROVE: "1" });
      assert.equal(refused.status, 2, refused.stdout + refused.stderr);
      assert.match(refused.stdout + refused.stderr, /changed since preview/);
      assert.ok(existsSync(journal));
      assert.equal(readFileSync(ignore, "utf8"), "# conflicting edit\n");
      writeFileSync(ignore, saved);
    }
    const resumed = run({ MIGRATION_APPROVE: "1" });
    assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
    if (stage === "relocation") assert.match(git(root, "show", ":.gitmodules"), /vendor-topic/);
    assert.equal(existsSync(journal), false);
    assert.equal(git(root, "rev-parse", "HEAD"), head);
    assert.equal(git(root, "ls-files", "oms/api"), "");
    assert.equal(git(tree, "rev-parse", "--path-format=absolute", "--git-common-dir"), join(api, ".git"));
    assert.equal(readFileSync(join(tree, "extra"), "utf8"), "keep linked data");
  }
});
