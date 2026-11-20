import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { aliasRegistrations } from "../../scripts/lib/alias-registration.js";
import { prepareAlias, resolveDetachedHead } from "../../scripts/lib/alias-preparation.js";
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
  const policies = [
    { command: "commit", topologyOffer: false },
    { command: "fetch", topologyOffer: true },
  ] as const;
  const cwd = cloneWithUninitializedApi();
  const loaded = loadRepos({ cwd });
  assert.ok(loaded);
  const before = rootSnapshot(cwd);
  for (let index = 0; index < policies.length; index += 1) {
    const { command, topologyOffer } = policies[index]!;
    const result = await prepareAlias(loaded.repoRoot, loaded.repos[0]!, {
      command,
      topologyOffer,
      allowPendingRegistration: true,
    });
    assert.deepEqual(result, { ok: true }, command);
    assert.equal(existsSync(join(cwd, "oms", "api", ".git")), true, command);
    assert.deepEqual(rootSnapshot(cwd), before, command);
    if (index < policies.length - 1) {
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
    allowPendingRegistration: true,
  });
  const dir = join(cwd, "oms", "api");
  assert.deepEqual(result, { ok: true });
  assert.equal(gitOut(dir, "rev-parse", "HEAD"), pinned);
  assert.equal(gitOut(dir, "branch", "--show-current"), "");
  assert.deepEqual(rootSnapshot(cwd), before);

  git(dir, "branch", "a-topic");
  git(dir, "branch", "z-topic");
  git(dir, "tag", "a-topic", "refs/remotes/origin/main");
  writeFileSync(join(gitOut(dir, "rev-parse", "--absolute-git-dir"), "refs", "heads", "0-broken"), `${"1".repeat(40)}\n`);
  assert.deepEqual(await resolveDetachedHead(loaded.repoRoot, loaded.repos[0]!, "commit"), { ok: true, branch: "a-topic" });
  assert.equal(gitOut(dir, "symbolic-ref", "HEAD"), "refs/heads/a-topic");
  assert.equal(gitOut(dir, "rev-parse", "HEAD"), pinned);

  git(dir, "switch", "--detach", pinned);
  git(dir, "branch", "-f", "a-topic", "refs/remotes/origin/main");
  git(dir, "branch", "a-topic\u00a0");
  assert.deepEqual(await resolveDetachedHead(loaded.repoRoot, loaded.repos[0]!, "commit"), { ok: true, branch: "a-topic\u00a0" });
  assert.equal(execFileSync("git", ["symbolic-ref", "HEAD"], { cwd: dir, env: testEnv, encoding: "utf8" }), "refs/heads/a-topic\u00a0\n");
  assert.equal(gitOut(dir, "rev-parse", "HEAD"), pinned);
});

test("preparation registers an offered alias once and continues with its manifest state", async () => {
  const command = "fetch";
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
      allowPendingRegistration: true,
    });
    assert.deepEqual(result, { ok: true }, command);
    assert.equal(Number(gitOut(cwd, "rev-list", "--count", "HEAD")), beforeCount, command);
    assert.match(gitOut(cwd, "diff", "--cached", "--name-only"), /^oms\/api$/m);
    assert.deepEqual(
      await prepareAlias(loaded.repoRoot, loaded.repos[0]!, { command, topologyOffer: true, allowPendingRegistration: true }),
      { ok: true },
    );
    const before = rootSnapshot(cwd);
    assert.deepEqual(
      await prepareAlias(loaded.repoRoot, loaded.repos[0]!, { command, topologyOffer: true, allowPendingRegistration: false }),
      { ok: false, code: 1 },
    );

    git(cwd, "config", "--file", ".gitmodules", "submodule.oms//api.path", "oms//api");
    assert.deepEqual(
      await prepareAlias(loaded.repoRoot, loaded.repos[0]!, { command, topologyOffer: true, allowPendingRegistration: true }),
      { ok: false, code: 1 },
    );
    git(cwd, "config", "--file", ".gitmodules", "--remove-section", "submodule.oms//api");
    assert.deepEqual(rootSnapshot(cwd), before);

    git(join(cwd, "oms", "api"), "commit", "--allow-empty", "-m", "move the pending checkout");
    assert.deepEqual(
      await prepareAlias(loaded.repoRoot, loaded.repos[0]!, { command, topologyOffer: true, allowPendingRegistration: true }),
      { ok: true },
    );
    git(cwd, "restore", "--staged", "--", ".gitmodules", "oms/api");
    assert.deepEqual(
      await prepareAlias(loaded.repoRoot, loaded.repos[0]!, { command, topologyOffer: true, allowPendingRegistration: true }),
      { ok: true },
    );

    const moduleBlob = gitOut(cwd, "hash-object", "-w", "oms.yaml");
    git(cwd, "update-index", "--add", "--cacheinfo", `100644,${moduleBlob},oms/api`);
    for (const [blocked, topologyOffer] of [["commit", false], ["tree add", true]] as const) {
      assert.deepEqual(
        await prepareAlias(loaded.repoRoot, loaded.repos[0]!, { command: blocked, topologyOffer, allowPendingRegistration: true }),
        { ok: false, code: 1 },
      );
    }
  } finally {
    __resetPromptQueueForTests();
    process.chdir(originalCwd);
    if (previousResponses === undefined) delete process.env.OMS_TEST_PROMPT_RESPONSES;
    else process.env.OMS_TEST_PROMPT_RESPONSES = previousResponses;
    if (previousMode === undefined) delete process.env.OMS_TEST_MODE;
    else process.env.OMS_TEST_MODE = previousMode;
  }
});

test("batch registration preserves a healthy alias when another index listing is oversized", () => {
  const { cwd } = workspaceWithApi();
  const oid = gitOut(cwd, "hash-object", "-w", "oms.yaml");
  const entries = Array.from({ length: 16000 }, (_, index) =>
    `100644 ${oid}\toms/oversized/long-staged-path-for-registration-${String(index).padStart(5, "0")}\0`).join("");
  execFileSync("git", ["update-index", "-z", "--index-info"], { cwd, env: testEnv, input: entries });

  const result = aliasRegistrations(cwd, ["oversized", "api"]);
  assert.equal(result.get("api")?.kind, "initialized");
  assert.ok(["partially registered", "indeterminate"].includes(result.get("oversized")?.kind ?? ""));
});
