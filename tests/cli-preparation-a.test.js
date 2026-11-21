import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { git, gitOut, initBareUpstream, initGitWorkspace, queueEnv, run, sourceFor, sourcesFor, tempFixture, testEnv, workspaceWithApi, writeSources } from "./helpers.js";

function rootSnapshot(cwd) {
  return {
    head: gitOut(cwd, "rev-parse", "HEAD"),
    index: gitOut(cwd, "ls-files", "--stage"),
  };
}

function assertRootSnapshot(cwd, before) {
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), before.head);
  assert.equal(gitOut(cwd, "ls-files", "--stage"), before.index);
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

function detachWithoutBranch(cwd) {
  const dir = join(cwd, "oms", "api");
  git(dir, "commit", "--allow-empty", "-m", "detached tip");
  const detached = gitOut(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "--detach", detached);
  git(dir, "branch", "-f", "main", "HEAD^");
  assert.equal(gitOut(dir, "branch", "--show-current"), "");
  return dir;
}

test("commands that presuppose local state refuse a missing checkout without touching the root", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", initBareUpstream()));
  const before = rootSnapshot(cwd);
  for (const args of [
    ["commit", "api", "-m", "x"],
    ["push", "api"],
    ["branch", "delete", "api", "feature/x"],
    ["branch", "clean", "api"],
  ]) {
    const result = run(args, { cwd, env: queueEnv([]) });
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly succeeded`);
    assert.match(output, /oms clone api/, args.join(" "));
    assert.doesNotMatch(output, /PROMPT_RESPONSES is exhausted/);
    assertRootSnapshot(cwd, before);
    assert.equal(existsSync(join(cwd, "oms", "api")), false);
  }
});

test("eligible non-interactive commands require an explicit clone first", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", initBareUpstream()));
  const before = rootSnapshot(cwd);
  for (const args of [
    ["fetch", "api"],
    ["pull", "api"],
    ["branch", "list", "api"],
    ["branch", "switch", "api", "work"],
    ["branch", "checkout", "api", "main"],
  ]) {
    const result = run(args, { cwd });
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /oms clone api/, args.join(" "));
    assert.equal(existsSync(join(cwd, "oms", "api")), false);
    assertRootSnapshot(cwd, before);
  }
});

test("pull --all asks once and clones three aliases without changing the root index or HEAD", () => {
  const cwd = initGitWorkspace();
  const bare = initBareUpstream();
  const aliases = ["api", "web", "core"];
  writeSources(cwd, sourcesFor(aliases.map((alias) => ({ alias, bare }))));
  git(cwd, "add", "oms.yaml");
  const before = rootSnapshot(cwd);
  const result = run(["pull", "--all"], {
    cwd,
    env: queueEnv([{ type: "select", value: "clone" }]),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Summary: pulled 3/);
  const tip = gitOut(bare, "rev-parse", "main");
  for (const alias of aliases) {
    assert.match(output, new RegExp(`${alias}: cloned`));
    assert.equal(gitOut(join(cwd, "oms", alias), "rev-parse", "HEAD"), tip);
    assert.equal(gitOut(cwd, "check-ignore", `oms/${alias}`), `oms/${alias}`);
  }
  assert.equal(existsSync(join(cwd, ".gitmodules")), false);
  assertRootSnapshot(cwd, before);
});

test("a partial delegated clone does not ask a second preparation question", () => {
  const cwd = initGitWorkspace();
  const missingOrigin = join(tempFixture("missing-origin-"), "absent.git");
  writeSources(cwd, sourcesFor([
    { alias: "api", bare: initBareUpstream() },
    { alias: "web", bare: missingOrigin },
  ]));
  const before = rootSnapshot(cwd);
  const result = run(["fetch", "--all"], {
    cwd,
    env: queueEnv([{ type: "select", value: "clone" }]),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.doesNotMatch(output, /PROMPT_RESPONSES is exhausted/);
  assert.match(output, /api: fetched/);
  assert.match(output, /web: git clone failed/);
  assert.match(output, /Summary: fetched 1, failed 1/);
  assert.equal(existsSync(join(cwd, "oms", "api", ".git")), true);
  assert.equal(existsSync(join(cwd, "oms", "web")), false);
  assertRootSnapshot(cwd, before);

  const pushed = run(["push", "api"], { cwd, env: queueEnv([]) });
  assert.equal(pushed.status, 0, pushed.stdout + pushed.stderr);
  assert.match(pushed.stdout + pushed.stderr, /api\/main: pushed/);
  assertRootSnapshot(cwd, before);
});

test("fetch retries one transient failure and succeeds without an error", () => {
  const { cwd, wt } = workspaceWithApi();
  const remoteHead = gitOut(wt, "rev-parse", "refs/remotes/origin/main");
  git(wt, "update-ref", "-d", "refs/remotes/origin/main");
  const rootHead = gitOut(cwd, "rev-parse", "HEAD");
  const rootIndex = gitOut(cwd, "ls-files", "--stage");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const stubDir = tempFixture("oms-fetch-retry-");
  const attempts = join(stubDir, "fetch-attempts");
  const stubGit = join(stubDir, "git");
  writeFileSync(
    stubGit,
    `#!/usr/bin/env bash\nif [ "$1" = "fetch" ]; then echo attempt >> ${JSON.stringify(attempts)}; if [ "$(wc -l < ${JSON.stringify(attempts)})" -eq 1 ]; then exit 91; fi; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
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
  assert.equal(readFileSync(attempts, "utf8").trim().split("\n").length, 2);
  assert.equal(gitOut(wt, "rev-parse", "refs/remotes/origin/main"), remoteHead);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootHead);
  assert.equal(gitOut(cwd, "ls-files", "--stage"), rootIndex);
});

test("two fetch failures report the exit code and later aliases still run", () => {
  const api = initBareUpstream();
  const web = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor([{ alias: "api", bare: api }, { alias: "web", bare: web }]));
  const cloned = run(["clone", "--all"], { cwd });
  assert.equal(cloned.status, 0, cloned.stdout + cloned.stderr);
  git(join(cwd, "oms", "web"), "update-ref", "-d", "refs/remotes/origin/main");

  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const stubDir = tempFixture("oms-fetch-failure-");
  const attempts = join(stubDir, "attempts");
  const stubGit = join(stubDir, "git");
  writeFileSync(
    stubGit,
    `#!/usr/bin/env bash\nif [ "$1" = "fetch" ] && [[ "$PWD" == */oms/api ]]; then echo attempt >> ${JSON.stringify(attempts)}; exit 92; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
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
  assert.equal(readFileSync(attempts, "utf8").trim().split("\n").length, 2);
  assert.equal(gitOut(join(cwd, "oms", "web"), "rev-parse", "refs/remotes/origin/main"), gitOut(web, "rev-parse", "refs/heads/main"));
});

test("preparation defaults follow selection scope and skip remains successful", () => {
  const namedOrigin = initBareUpstream();
  const named = initGitWorkspace();
  writeSources(named, sourcesFor([{ alias: "api", bare: namedOrigin }, { alias: "web", bare: namedOrigin }]));
  const namedResult = run(["fetch", "api"], {
    cwd: named,
    env: queueEnv([{ type: "select", default: true }]),
  });
  assert.equal(namedResult.status, 0, namedResult.stdout + namedResult.stderr);
  assert.equal(existsSync(join(named, "oms", "api", ".git")), true);
  assert.equal(existsSync(join(named, "oms", "web")), false);

  const soleOrigin = initBareUpstream();
  const sole = initGitWorkspace();
  writeSources(sole, sourceFor("api", soleOrigin));
  const soleResult = run(["branch", "list"], {
    cwd: sole,
    env: queueEnv([{ type: "select", default: true }]),
  });
  assert.equal(soleResult.status, 0, soleResult.stdout + soleResult.stderr);
  assert.equal(existsSync(join(sole, "oms", "api", ".git")), true);

  const { cwd: mixed, wt, bare } = workspaceWithApi();
  writeSources(mixed, sourcesFor([{ alias: "api", bare }, { alias: "web", bare: initBareUpstream() }]));
  git(wt, "update-ref", "-d", "refs/remotes/origin/main");
  const before = rootSnapshot(mixed);
  const cancelled = run(["fetch", "--all"], {
    cwd: mixed,
    env: queueEnv([{ type: "select", value: "cancel" }]),
  });
  assert.equal(cancelled.status, 1, cancelled.stdout + cancelled.stderr);
  assert.match(cancelled.stdout + cancelled.stderr, /No repositories were changed/);
  assert.equal(gitOut(wt, "for-each-ref", "--format=%(objectname)", "refs/remotes/origin/main"), "");
  assert.equal(existsSync(join(mixed, "oms", "web")), false);
  assertRootSnapshot(mixed, before);
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
  assert.equal(gitOut(wt, "rev-parse", "refs/remotes/origin/main"), gitOut(bare, "rev-parse", "refs/heads/main"));
  assertRootSnapshot(mixed, before);
});

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
  assert.match(blockedOutput, /no available local branch at the same commit/);
  assert.equal(gitOut(blockedDir, "branch", "--show-current"), "");

  for (const command of ["commit", "pull", "push"]) {
    const { cwd } = workspaceWithApi();
    const dir = detachWithoutBranch(cwd);
    const head = gitOut(dir, "rev-parse", "HEAD");
    if (command === "commit") writeFileSync(join(dir, "work.txt"), "uncommitted");
    const before = rootSnapshot(cwd);
    const args = command === "commit" ? [command, "api", "-m", "x"] : [command, "api"];
    const result = run(args, { cwd });
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, `${command} unexpectedly succeeded`);
    assert.match(output, /detached HEAD/, command);
    assert.match(output, /oms branch switch api/, command);
    assert.equal(gitOut(dir, "branch", "--show-current"), "");
    assert.equal(gitOut(dir, "rev-parse", "HEAD"), head);
    assertRootSnapshot(cwd, before);
  }
});

test("detached HEAD creates a branch through the queued text prompt", () => {
  const create = { type: "select", value: "\0create" };

  const created = workspaceWithApi();
  const createdDir = detachWithoutBranch(created.cwd);
  const head = gitOut(createdDir, "rev-parse", "HEAD");
  const result = run(["push", "api"], {
    cwd: created.cwd,
    env: queueEnv([create, { type: "text", value: "work/detached" }]),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /api\/work\/detached: pushed/);
  assert.equal(gitOut(createdDir, "branch", "--show-current"), "work/detached");
  assert.equal(gitOut(created.bare, "rev-parse", "refs/heads/work/detached"), head);

  const empty = workspaceWithApi();
  const emptyDir = detachWithoutBranch(empty.cwd);
  const rejected = run(["push", "api"], {
    cwd: empty.cwd,
    env: queueEnv([create, { type: "text", value: "   " }]),
  });
  assert.equal(rejected.status, 2, rejected.stdout + rejected.stderr);
  assert.match(rejected.stdout + rejected.stderr, /api: branch name is empty/);
  assert.equal(gitOut(emptyDir, "branch", "--show-current"), "");

  const cancelled = workspaceWithApi();
  const cancelledDir = detachWithoutBranch(cancelled.cwd);
  const stopped = run(["push", "api"], {
    cwd: cancelled.cwd,
    env: queueEnv([create, { type: "cancel" }]),
  });
  assert.equal(stopped.status, 2, stopped.stdout + stopped.stderr);
  assert.match(stopped.stdout + stopped.stderr, /Cancelled/);
  assert.equal(gitOut(cancelledDir, "branch", "--show-current"), "");
});

test("every preparing command refuses legacy registration with migration guidance", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  const manifest = `[submodule "oms/api"]\n\tpath = oms/api\n\turl = file://${bare}\n`;
  writeFileSync(join(cwd, ".gitmodules"), manifest);
  const before = rootSnapshot(cwd);
  for (const args of preparingCommands) {
    const result = run(args, { cwd, env: queueEnv([]) });
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly succeeded`);
    assert.match(output, /legacy source data or registration/, args.join(" "));
    assert.match(output, /oms migrate --dry-run/, args.join(" "));
    assert.doesNotMatch(output, /PROMPT_RESPONSES is exhausted/);
    assertRootSnapshot(cwd, before);
  }
  assert.equal(readFileSync(join(cwd, ".gitmodules"), "utf8"), manifest);
  assert.equal(existsSync(join(cwd, "oms", "api")), false);
});

test("fetch does not adopt a foreign checkout even with clone consent available", () => {
  const { cwd, bare } = workspaceWithApi();
  const foreign = initBareUpstream();
  const path = join(cwd, "oms", "web");
  writeSources(cwd, sourcesFor([{ alias: "api", bare }, { alias: "web", bare }]));
  execFileSync("git", ["clone", `file://${foreign}`, path], { stdio: "ignore", env: testEnv });
  const before = rootSnapshot(cwd);
  const result = run(["fetch", "--all"], { cwd, env: queueEnv([]) });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /web: origin does not match the current declaration/);
  assert.match(output, /api: fetched/);
  assert.doesNotMatch(output, /web: fetched|PROMPT_RESPONSES is exhausted/);
  assert.equal(gitOut(path, "remote", "get-url", "origin"), `file://${foreign}`);
  assertRootSnapshot(cwd, before);
});

test("status and doctor report a missing alias without preparing it", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", initBareUpstream()));
  const before = rootSnapshot(cwd);
  for (const command of ["status", "doctor"]) {
    const result = run([command], { cwd, env: queueEnv([]) });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /api.*not cloned/);
    assert.equal(existsSync(join(cwd, "oms", "api")), false);
    assertRootSnapshot(cwd, before);
  }
});

test("pull stops when Git refuses branch attachment and preserves the detached commit", () => {
  const { cwd, wt } = workspaceWithApi();
  git(wt, "switch", "--detach");
  const before = rootSnapshot(cwd);
  const head = gitOut(wt, "rev-parse", "HEAD");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const stubDir = tempFixture("oms-prepare-attach-failure-");
  const stubGit = join(stubDir, "git");
  writeFileSync(
    stubGit,
    `#!/usr/bin/env bash\nif [ "$1" = "switch" ] && [ "$4" = "main" ]; then echo "simulated attach failure" >&2; exit 93; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
  );
  chmodSync(stubGit, 0o755);

  const result = run(["pull", "api"], { cwd, env: { ...testEnv, PATH: `${stubDir}${delimiter}${testEnv.PATH}` } });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /simulated attach failure/);
  assert.doesNotMatch(output, /pulled from/);
  assert.equal(gitOut(wt, "rev-parse", "HEAD"), head);
  assert.equal(gitOut(wt, "branch", "--show-current"), "");
  assertRootSnapshot(cwd, before);
});
