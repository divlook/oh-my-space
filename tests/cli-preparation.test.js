import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  configIdentity,
  git,
  gitOut,
  initBareUpstream,
  initGitWorkspace,
  queueEnv,
  run,
  sourceFor,
  sourcesFor,
  tempFixture,
  testEnv,
  workspaceWithApi,
  writeSources,
} from "./helpers.js";

function rootSnapshot(cwd) {
  return {
    head: gitOut(cwd, "rev-parse", "HEAD"),
    index: gitOut(cwd, "diff", "--cached", "--name-status"),
  };
}

function assertRootSnapshot(cwd, before) {
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), before.head);
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-status"), before.index);
}

function cloneWithUninitializedApi() {
  const source = workspaceWithApi().cwd;
  const cwd = tempFixture("oms-uninitialized-");
  execFileSync("git", ["clone", source, cwd], { stdio: "ignore", env: testEnv });
  configIdentity(cwd);
  assert.equal(existsSync(join(cwd, "oms", "api", ".git")), false);
  return cwd;
}

const preparingCommands = [
  ["commit", "api"],
  ["fetch", "api"],
  ["pull", "api"],
  ["push", "api"],
  ["branch", "list", "api"],
  ["branch", "switch", "api", "main"],
  ["branch", "checkout", "api", "main"],
  ["branch", "delete", "api"],
];

const offerCommands = [
  ["fetch", "api"],
  ["pull", "api"],
  ["branch", "list", "api"],
  ["branch", "switch", "api", "main"],
  ["branch", "checkout", "api", "main"],
];

test("all eight preparing commands auto-initialize without changing root topology", () => {
  for (const args of preparingCommands) {
    const cwd = cloneWithUninitializedApi();
    const before = rootSnapshot(cwd);
    const result = run(args, { cwd });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 0, `${args.join(" ")}\n${output}`);
    assert.match(output, /initializing registered submodule/, args.join(" "));
    assert.equal(existsSync(join(cwd, "oms", "api", ".git")), true, args.join(" "));
    assertRootSnapshot(cwd, before);
  }
});

test("auto-initialization leaves a pinned commit alone when the baseline branch is ahead", () => {
  // A submodule clone creates its baseline branch at the remote tip, which is ahead of the recorded
  // pointer whenever someone pushed without recording it. Attaching to it would move the checkout
  // during preparation, so preparation leaves HEAD detached at the pinned commit instead.
  const bare = initBareUpstream();
  const source = initGitWorkspace();
  writeSources(source, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd: source }).status, 0);
  const wt = join(source, "oms", "api");
  const pinned = gitOut(source, "rev-parse", "HEAD:oms/api");
  git(wt, "commit", "--allow-empty", "-m", "upstream ahead of the pointer");
  git(wt, "push", "origin", "main");
  git(wt, "checkout", "--detach", pinned);
  git(wt, "branch", "-f", "main", "origin/main");
  assert.equal(gitOut(source, "status", "--short"), "");

  const listed = tempFixture("oms-ahead-list-");
  execFileSync("git", ["clone", source, listed], { stdio: "ignore", env: testEnv });
  configIdentity(listed);
  const beforeList = rootSnapshot(listed);
  const list = run(["branch", "list", "api"], { cwd: listed });
  assert.equal(list.status, 0, list.stdout + list.stderr);
  assert.equal(gitOut(join(listed, "oms", "api"), "rev-parse", "HEAD"), pinned);
  assert.equal(gitOut(join(listed, "oms", "api"), "branch", "--show-current"), "");
  assert.equal(gitOut(listed, "status", "--short"), "");
  assertRootSnapshot(listed, beforeList);

  // Commit needs a branch, so it reports the detached HEAD instead of silently moving to the tip.
  const committed = tempFixture("oms-ahead-commit-");
  execFileSync("git", ["clone", source, committed], { stdio: "ignore", env: testEnv });
  configIdentity(committed);
  const beforeCommit = rootSnapshot(committed);
  const result = run(["commit", "api", "-m", "x"], { cwd: committed });
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /detached HEAD/);
  assert.match(output, /oms branch switch api/);
  assert.equal(gitOut(join(committed, "oms", "api"), "rev-parse", "HEAD"), pinned);
  assertRootSnapshot(committed, beforeCommit);
});

test("the five offer-side commands register once and continue", () => {
  for (const args of offerCommands) {
    const bare = initBareUpstream();
    const cwd = initGitWorkspace();
    writeSources(cwd, sourceFor("api", bare));
    const beforeCount = Number(gitOut(cwd, "rev-list", "--count", "HEAD"));
    const result = run(args, { cwd, env: queueEnv([{ type: "select", value: "sync" }]) });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 0, `${args.join(" ")}\n${output}`);
    assert.equal(Number(gitOut(cwd, "rev-list", "--count", "HEAD")), beforeCount + 1, args.join(" "));
    assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
    assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
  }
});

test("commands that presuppose local state refuse an unregistered alias without touching root state", () => {
  const cases = [
    ["commit", "api", "-m", "x"],
    ["push", "api"],
    ["branch", "delete", "api", "feature/x"],
  ];
  for (const args of cases) {
    const bare = initBareUpstream();
    const cwd = initGitWorkspace();
    writeSources(cwd, sourceFor("api", bare));
    const before = rootSnapshot(cwd);
    const result = run(args, { cwd });
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly succeeded`);
    assert.match(output, /oms sync api/, args.join(" "));
    assertRootSnapshot(cwd, before);
    assert.equal(existsSync(join(cwd, ".gitmodules")), false);
  }
});

test("pull --all asks once and registers three aliases in one topology commit", () => {
  const origins = [initBareUpstream(), initBareUpstream(), initBareUpstream()];
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor([
    { alias: "api", bare: origins[0] },
    { alias: "web", bare: origins[1] },
    { alias: "core", bare: origins[2] },
  ]));
  const beforeCount = Number(gitOut(cwd, "rev-list", "--count", "HEAD"));
  const result = run(["pull", "--all"], {
    cwd,
    env: queueEnv([{ type: "select", value: "sync" }]),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.equal(Number(gitOut(cwd, "rev-list", "--count", "HEAD")), beforeCount + 1);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add submodules");
  assert.match(output, /pulled 3/);
});

test("a partial delegated sync does not ask a second preparation question", () => {
  const cwd = initGitWorkspace();
  const missingOrigin = join(tempFixture("missing-origin-"), "absent.git");
  writeSources(cwd, sourcesFor([
    { alias: "api", bare: initBareUpstream() },
    { alias: "web", bare: missingOrigin },
  ]));
  const beforeCount = Number(gitOut(cwd, "rev-list", "--count", "HEAD"));
  const result = run(["fetch", "--all"], {
    cwd,
    env: queueEnv([{ type: "select", value: "sync" }]),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.doesNotMatch(output, /response queue is exhausted/);
  assert.match(output, /api: fetched/);
  assert.equal(existsSync(join(cwd, "oms", "api", ".git")), true);
  assert.equal(existsSync(join(cwd, "oms", "web", ".git")), false);
  assert.equal(Number(gitOut(cwd, "rev-list", "--count", "HEAD")), beforeCount + 1);
});

test("fetch retries one transient failure and succeeds without an error", () => {
  const { cwd } = workspaceWithApi();
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const stubDir = tempFixture("oms-fetch-retry-");
  const marker = join(stubDir, "failed-once");
  const stubGit = join(stubDir, "git");
  writeFileSync(
    stubGit,
    `#!/usr/bin/env bash\nif [ "$1" = "fetch" ] && [ ! -e ${JSON.stringify(marker)} ]; then : > ${JSON.stringify(marker)}; exit 91; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
  );
  chmodSync(stubGit, 0o755);

  const result = run(["fetch", "api"], {
    cwd,
    env: { ...testEnv, PATH: `${stubDir}${delimiter}${testEnv.PATH}` },
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /api: fetched/);
  assert.doesNotMatch(output, /failed/);
  assert.equal(existsSync(marker), true);
});

test("two fetch failures report the exit code and later aliases still run", () => {
  const api = initBareUpstream();
  const web = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor([{ alias: "api", bare: api }, { alias: "web", bare: web }]));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  assert.equal(run(["sync", "web"], { cwd }).status, 0);

  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const stubDir = tempFixture("oms-fetch-failure-");
  const stubGit = join(stubDir, "git");
  writeFileSync(
    stubGit,
    `#!/usr/bin/env bash\nif [ "$1" = "fetch" ] && [[ "$PWD" == */oms/api ]]; then exit 92; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
  );
  chmodSync(stubGit, 0o755);

  const result = run(["fetch", "--all"], {
    cwd,
    env: { ...testEnv, PATH: `${stubDir}${delimiter}${testEnv.PATH}` },
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /api: fetch origin failed \(exit 92\)/);
  assert.match(output, /web: fetched/);
  assert.match(output, /Summary: fetched 1, failed 1/);
});

test("preparation defaults follow selection scope and skip remains successful", () => {
  const namedOrigin = initBareUpstream();
  const named = initGitWorkspace();
  writeSources(named, sourceFor("api", namedOrigin));
  const namedResult = run(["fetch", "api"], {
    cwd: named,
    env: queueEnv([{ type: "select", default: true }]),
  });
  assert.equal(namedResult.status, 0, namedResult.stdout + namedResult.stderr);

  const soleOrigin = initBareUpstream();
  const sole = initGitWorkspace();
  writeSources(sole, sourceFor("api", soleOrigin));
  const soleResult = run(["branch", "list"], {
    cwd: sole,
    env: queueEnv([{ type: "select", default: true }]),
  });
  assert.equal(soleResult.status, 0, soleResult.stdout + soleResult.stderr);

  const registeredOrigin = initBareUpstream();
  const skippedOrigin = initBareUpstream();
  const mixed = initGitWorkspace();
  writeSources(mixed, sourcesFor([{ alias: "api", bare: registeredOrigin }, { alias: "web", bare: skippedOrigin }]));
  assert.equal(run(["sync", "api"], { cwd: mixed }).status, 0);
  const before = rootSnapshot(mixed);
  const skipped = run(["fetch", "--all"], {
    cwd: mixed,
    env: queueEnv([{ type: "select", default: true }]),
  });
  const output = skipped.stdout + skipped.stderr;
  assert.equal(skipped.status, 0, output);
  assert.match(output, /web: skipped/);
  assert.match(output, /api: fetched/);
  assert.match(output, /Summary: fetched 1, skipped 1/);
  assert.equal(existsSync(join(mixed, "oms", "web", ".git")), false);
  assertRootSnapshot(mixed, before);
});

function detachWithoutBranch(cwd) {
  const dir = join(cwd, "oms", "api");
  git(dir, "commit", "--allow-empty", "-m", "detached tip");
  const detached = gitOut(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "--detach", detached);
  git(dir, "branch", "-f", "main", "HEAD^");
  assert.equal(gitOut(dir, "branch", "--show-current"), "");
  return dir;
}

test("detached HEAD attaches safely, offers a moving choice, and fails without intent", () => {
  for (const command of ["commit", "pull", "push"]) {
    const { cwd } = workspaceWithApi();
    const dir = join(cwd, "oms", "api");
    git(dir, "checkout", "--detach");
    if (command === "commit") writeFileSync(join(dir, "work.txt"), "x");
    const args = command === "commit" ? [command, "api", "-m", "attached work"] : [command, "api"];
    const result = run(args, { cwd });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 0, `${command}\n${output}`);
    assert.match(output, /attached detached HEAD to "main"/, command);
    assert.equal(gitOut(dir, "branch", "--show-current"), "main");
  }

  const interactive = workspaceWithApi();
  detachWithoutBranch(interactive.cwd);
  const moved = run(["pull", "api"], {
    cwd: interactive.cwd,
    env: queueEnv([{ type: "select", value: "main" }]),
  });
  assert.equal(moved.status, 0, moved.stdout + moved.stderr);
  assert.equal(gitOut(join(interactive.cwd, "oms", "api"), "branch", "--show-current"), "main");

  const blocked = workspaceWithApi();
  const blockedDir = join(blocked.cwd, "oms", "api");
  git(blockedDir, "checkout", "--detach");
  git(blockedDir, "worktree", "add", join(tempFixture("linked-worktree-"), "main"), "main");
  const blockedAttach = run(["pull", "api"], { cwd: blocked.cwd });
  const blockedOutput = blockedAttach.stdout + blockedAttach.stderr;
  assert.equal(blockedAttach.status, 2, blockedOutput);
  assert.match(blockedOutput, /could not attach detached HEAD/);
  assert.equal(gitOut(blockedDir, "branch", "--show-current"), "");

  for (const command of ["commit", "pull", "push"]) {
    const { cwd } = workspaceWithApi();
    const dir = detachWithoutBranch(cwd);
    const before = rootSnapshot(cwd);
    const args = command === "commit" ? [command, "api", "-m", "x"] : [command, "api"];
    const result = run(args, { cwd });
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, `${command} unexpectedly succeeded`);
    assert.match(output, /detached HEAD/, command);
    assert.match(output, /oms branch switch api/, command);
    assert.equal(gitOut(dir, "branch", "--show-current"), "");
    assertRootSnapshot(cwd, before);
  }
});

test("every preparing command refuses partial registration with repair guidance", () => {
  for (const args of preparingCommands) {
    const bare = initBareUpstream();
    const cwd = initGitWorkspace();
    writeSources(cwd, sourceFor("api", bare));
    writeFileSync(join(cwd, ".gitmodules"), `[submodule "oms/api"]\n\tpath = oms/api\n\turl = file://${bare}\n`);
    const before = rootSnapshot(cwd);
    const result = run(args, { cwd });
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly succeeded`);
    assert.match(output, /inconsistent|pending addition\/removal/, args.join(" "));
    assert.match(output, /oms sync api/, args.join(" "));
    assertRootSnapshot(cwd, before);
  }
});

test("status, doctor, and record report an uninitialized alias without preparing it", () => {
  const cwd = cloneWithUninitializedApi();
  const before = rootSnapshot(cwd);
  const status = run(["status", "--json"], { cwd });
  assert.equal(status.status, 0, status.stdout + status.stderr);
  const parsed = JSON.parse(status.stdout);
  assert.equal(parsed.repos.length, 1);
  assert.equal(parsed.repos[0].initialized, false);
  assert.equal(existsSync(join(cwd, "oms", "api", ".git")), false);

  const doctor = run(["doctor"], { cwd });
  assert.equal(doctor.status, 2, doctor.stdout + doctor.stderr);
  assert.equal(existsSync(join(cwd, "oms", "api", ".git")), false);
  const record = run(["record"], { cwd });
  assert.equal(record.status, 0, record.stdout + record.stderr);
  assert.match(record.stdout + record.stderr, /Nothing to record/);
  assert.equal(existsSync(join(cwd, "oms", "api", ".git")), false);
  assertRootSnapshot(cwd, before);
});

test("automatic initialization stops when Git refuses the baseline attachment", () => {
  // Routing preparation through the shared attachment primitive surfaces a refused branch operation
  // that used to be swallowed. Nothing downstream can assume the alias is prepared, so the command
  // stops with Git's own diagnostic instead of continuing against an unattached submodule.
  const cwd = cloneWithUninitializedApi();
  const before = rootSnapshot(cwd);
  const pinned = gitOut(cwd, "rev-parse", "HEAD:oms/api");

  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const stubDir = tempFixture("oms-prepare-attach-failure-");
  const stubGit = join(stubDir, "git");
  writeFileSync(
    stubGit,
    `#!/usr/bin/env bash\nif [ "$1" = "switch" ] && [ "$2" = "main" ]; then echo "simulated attach failure" >&2; exit 93; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
  );
  chmodSync(stubGit, 0o755);

  const result = run(["fetch", "api"], { cwd, env: { ...testEnv, PATH: `${stubDir}${delimiter}${testEnv.PATH}` } });
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /simulated attach failure/);
  assert.match(output, /could not attach detached HEAD to "main"/);
  assert.equal(gitOut(join(cwd, "oms", "api"), "rev-parse", "HEAD"), pinned);
  assert.equal(gitOut(join(cwd, "oms", "api"), "branch", "--show-current"), "");
  assertRootSnapshot(cwd, before);
});
