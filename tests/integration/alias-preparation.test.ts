import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { __resetPromptQueueForTests } from "../../scripts/lib/prompt-adapter.js";
import { resolveSourceBranch } from "../../scripts/lib/source-attachment.js";
import { openSourceWorkspace } from "../../scripts/lib/source-checkout.js";
import { prepareSources, requireSource } from "../../scripts/lib/source-preparation.js";
import {
  git,
  gitOut,
  initBareUpstream,
  initGitWorkspace,
  testEnv,
  workspaceWithApi,
} from "../helpers.js";

Object.assign(process.env, testEnv);

function rootSnapshot(cwd: string) {
  return {
    head: gitOut(cwd, "rev-parse", "HEAD"),
    index: gitOut(cwd, "ls-files", "--stage"),
  };
}

test("preparation uses existing independent checkouts without changing root state", async () => {
  const { cwd, bare, wt } = workspaceWithApi();
  const repo = { alias: "api", remotes: { origin: `file://${bare}` } };
  const workspace = openSourceWorkspace(cwd);
  const before = rootSnapshot(cwd);
  const checkout = requireSource(workspace, repo);
  assert.ok(checkout);
  assert.equal(checkout.path, join(workspace.root, "oms", "api"));
  assert.equal(checkout.gitDir, join(checkout.path, ".git"));
  const head = gitOut(wt, "rev-parse", "HEAD");
  for (const command of ["fetch", "push"] as const) {
    assert.deepEqual((await prepareSources(workspace, [repo], command, command === "push" ? "fail" : "offer-clone"))?.get("api"), checkout);
  }
  assert.equal(gitOut(wt, "rev-parse", "HEAD"), head);
  assert.deepEqual(rootSnapshot(cwd), before);
});

test("preparation preserves a detached commit when the baseline branch has advanced", async () => {
  const { cwd, bare, wt } = workspaceWithApi();
  const repo = { alias: "api", remotes: { origin: `file://${bare}` }, branch: "main" };
  const workspace = openSourceWorkspace(cwd);
  const before = rootSnapshot(cwd);
  const head = gitOut(wt, "rev-parse", "HEAD");
  git(wt, "commit", "--allow-empty", "-m", "advance baseline");
  git(wt, "push", "origin", "main");
  git(wt, "switch", "--detach", head);

  const prepared = (await prepareSources(workspace, [repo], "branch list", "offer-clone"))?.get("api");
  assert.ok(prepared?.kind === "ready");
  assert.equal(gitOut(wt, "rev-parse", "HEAD"), head);
  assert.equal(gitOut(wt, "branch", "--show-current"), "");

  git(wt, "branch", "a-topic");
  git(wt, "branch", "z-topic");
  git(wt, "tag", "a-topic", "refs/remotes/origin/main");
  writeFileSync(join(wt, ".git", "refs", "heads", "0-broken"), `${"1".repeat(40)}\n`);
  assert.deepEqual(await resolveSourceBranch(workspace, repo, prepared, "commit"), { ok: true, branch: "a-topic" });
  assert.equal(gitOut(wt, "symbolic-ref", "HEAD"), "refs/heads/a-topic");
  assert.equal(gitOut(wt, "rev-parse", "HEAD"), head);

  git(wt, "switch", "--detach", head);
  git(wt, "branch", "-f", "a-topic", "refs/remotes/origin/main");
  git(wt, "branch", "a-topic\u00a0");
  assert.deepEqual(await resolveSourceBranch(workspace, repo, prepared, "commit"), { ok: true, branch: "a-topic\u00a0" });
  assert.equal(execFileSync("git", ["symbolic-ref", "HEAD"], { cwd: wt, env: testEnv, encoding: "utf8" }), "refs/heads/a-topic\u00a0\n");
  assert.equal(gitOut(wt, "rev-parse", "HEAD"), head);
  assert.deepEqual(rootSnapshot(cwd), before);
});

test("preparation clones an offered alias once and continues with its manifest state", async () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = initGitWorkspace();
  const repo = { alias: "api", remotes: { origin: `file://${bare}` }, branch: "dev" };
  const workspace = openSourceWorkspace(cwd);
  const before = rootSnapshot(cwd);
  const previousMode = process.env.OMS_TEST_MODE;
  const previousResponses = process.env.OMS_TEST_PROMPT_RESPONSES;
  process.env.OMS_TEST_MODE = "1";
  process.env.OMS_TEST_PROMPT_RESPONSES = JSON.stringify([{ type: "select", value: "clone" }]);
  __resetPromptQueueForTests();
  try {
    const prepared = await prepareSources(workspace, [repo], "fetch", "offer-clone");
    const checkout = prepared?.get("api");
    assert.ok(checkout?.kind === "ready");
    assert.equal(gitOut(checkout.path, "branch", "--show-current"), "dev");
    assert.equal(gitOut(checkout.path, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/dev");
    assert.equal(gitOut(cwd, "check-ignore", "oms/api"), "oms/api");
    assert.equal(existsSync(join(cwd, ".gitmodules")), false);
    git(checkout.path, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "local work");
    const head = gitOut(checkout.path, "rev-parse", "HEAD");
    assert.deepEqual((await prepareSources(workspace, [repo], "fetch", "offer-clone"))?.get("api"), checkout);
    assert.equal(gitOut(checkout.path, "rev-parse", "HEAD"), head);
    assert.deepEqual(rootSnapshot(cwd), before);
  } finally {
    if (previousResponses === undefined) delete process.env.OMS_TEST_PROMPT_RESPONSES;
    else process.env.OMS_TEST_PROMPT_RESPONSES = previousResponses;
    if (previousMode === undefined) delete process.env.OMS_TEST_MODE;
    else process.env.OMS_TEST_MODE = previousMode;
    __resetPromptQueueForTests();
  }
});

test("batch preparation preserves a healthy alias when another path is tracked by the workspace", async () => {
  const { cwd, bare } = workspaceWithApi();
  const oid = gitOut(cwd, "hash-object", "-w", "oms.yaml");
  git(cwd, "update-index", "--add", "--cacheinfo", `100644,${oid},oms/tracked/file.txt`);
  const before = rootSnapshot(cwd);

  const workspace = openSourceWorkspace(cwd);
  const remotes = { origin: `file://${bare}` };
  const result = await prepareSources(workspace, [{ alias: "tracked", remotes }, { alias: "api", remotes }], "push", "fail");
  assert.equal(result?.get("tracked")?.kind, "failed");
  assert.equal(result?.get("api")?.kind, "ready");
  assert.deepEqual(rootSnapshot(cwd), before);
});
