import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { prepareAlias } from "../../scripts/lib/alias-preparation.js";
import { loadRepos } from "../../scripts/lib/manifest.js";
import { __resetPromptQueueForTests } from "../../scripts/lib/prompt-adapter.js";
import {
  configIdentity,
  git,
  gitOut,
  initBareUpstream,
  initGitWorkspace,
  sourceFor,
  syncedSubmodule,
  tempFixture,
  testEnv,
  workspaceWithApi,
  writeSources,
} from "../helpers.js";
Object.assign(process.env, testEnv);

function rootSnapshot(cwd: string) {
  return {
    head: gitOut(cwd, "rev-parse", "HEAD"),
    index: gitOut(cwd, "diff", "--cached", "--name-status"),
  };
}

function cloneWithUninitializedApi(): string {
  const source = workspaceWithApi().cwd;
  const cwd = tempFixture("oms-uninitialized-direct-");
  execFileSync("git", ["clone", source, cwd], { stdio: "ignore", env: testEnv });
  configIdentity(cwd);
  assert.equal(existsSync(join(cwd, "oms", "api", ".git")), false);
  return cwd;
}

test("preparation initializes registered aliases directly without changing root topology", async () => {
  const commands = [
    ["commit", false],
    ["fetch", true],
    ["pull", true],
    ["push", true],
    ["branch list", true],
    ["branch switch", true],
    ["branch checkout", true],
    ["branch delete", false],
  ] as const;
  const cwd = cloneWithUninitializedApi();
  const loaded = loadRepos({ cwd });
  assert.ok(loaded);
  const before = rootSnapshot(cwd);
  for (let index = 0; index < commands.length; index += 1) {
    const [command, topologyOffer] = commands[index]!;
    const result = await prepareAlias(loaded.repoRoot, loaded.repos[0]!, {
      command,
      topologyOffer,
    });
    assert.deepEqual(result, { ok: true }, command);
    assert.equal(existsSync(join(cwd, "oms", "api", ".git")), true, command);
    assert.deepEqual(rootSnapshot(cwd), before, command);
    if (index < commands.length - 1) {
      git(cwd, "submodule", "deinit", "-f", "oms/api");
    }
  }
});

test("preparation preserves a pinned detached commit when the baseline branch has advanced", async () => {
  const origin = initBareUpstream();
  const source = initGitWorkspace();
  const worktree = syncedSubmodule(source, "api", origin);
  const pinned = gitOut(source, "rev-parse", "HEAD:oms/api");
  git(worktree, "commit", "--allow-empty", "-m", "upstream ahead of the pointer");
  git(worktree, "push", "origin", "main");
  git(worktree, "checkout", "--detach", pinned);
  git(worktree, "branch", "-f", "main", "origin/main");

  const cwd = tempFixture("oms-ahead-direct-");
  execFileSync("git", ["clone", source, cwd], { stdio: "ignore", env: testEnv });
  configIdentity(cwd);
  const loaded = loadRepos({ cwd });
  assert.ok(loaded);
  const before = rootSnapshot(cwd);
  const result = await prepareAlias(loaded.repoRoot, loaded.repos[0]!, {
    command: "branch list",
    topologyOffer: true,
  });
  const dir = join(cwd, "oms", "api");
  assert.deepEqual(result, { ok: true });
  assert.equal(gitOut(dir, "rev-parse", "HEAD"), pinned);
  assert.equal(gitOut(dir, "branch", "--show-current"), "");
  assert.deepEqual(rootSnapshot(cwd), before);
});

test("preparation registers an offered alias once and continues with its manifest state", async () => {
  const commands = ["fetch", "pull", "branch list", "branch switch", "branch checkout"];
  for (const command of commands) {
    const origin = initBareUpstream();
    const cwd = initGitWorkspace();
    writeSources(cwd, sourceFor("api", origin));
    const loaded = loadRepos({ cwd });
    assert.ok(loaded);
    const beforeCount = Number(gitOut(cwd, "rev-list", "--count", "HEAD"));
    const originalCwd = process.cwd();
    const previousMode = process.env.OMS_TEST_MODE;
    const previousResponses = process.env.OMS_TEST_PROMPT_RESPONSES;
    process.chdir(cwd);
    process.env.OMS_TEST_MODE = "1";
    process.env.OMS_TEST_PROMPT_RESPONSES = JSON.stringify([{ type: "select", value: "sync" }]);
    __resetPromptQueueForTests();
    try {
      const result = await prepareAlias(loaded.repoRoot, loaded.repos[0]!, {
        command,
        topologyOffer: true,
      });
      assert.deepEqual(result, { ok: true }, command);
      assert.equal(Number(gitOut(cwd, "rev-list", "--count", "HEAD")), beforeCount + 1, command);
      assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
      assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
    } finally {
      __resetPromptQueueForTests();
      process.chdir(originalCwd);
      if (previousResponses === undefined) delete process.env.OMS_TEST_PROMPT_RESPONSES;
      else process.env.OMS_TEST_PROMPT_RESPONSES = previousResponses;
      if (previousMode === undefined) delete process.env.OMS_TEST_MODE;
      else process.env.OMS_TEST_MODE = previousMode;
    }
  }
});
