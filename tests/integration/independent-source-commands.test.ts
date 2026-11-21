import assert from "node:assert/strict";
import { cpSync, existsSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runSourceBranchClean } from "../../scripts/lib/branch-clean.js";
import { executeSourceBranchClean, planSourceBranchClean } from "../../scripts/lib/branch-clean-plan.js";
import { runSourceBranchDelete } from "../../scripts/lib/branch-delete.js";
import { runSourceBranchList } from "../../scripts/lib/branch-list.js";
import { runSourceCheckout, runSourceSwitch } from "../../scripts/lib/branch-ops.js";
import { cloneSource } from "../../scripts/lib/clone-source.js";
import { runSourceCommit } from "../../scripts/lib/commit.js";
import { productionGitRunner } from "../../scripts/lib/git.js";
import { runSourceManage } from "../../scripts/lib/manage-ops.js";
import { __resetPromptQueueForTests, assertPromptQueueDrained } from "../../scripts/lib/prompt-adapter.js";
import { runRemove } from "../../scripts/lib/remove-source.js";
import { inspectSourceCheckout } from "../../scripts/lib/source-checkout.js";
import { loadForSources } from "../../scripts/lib/source-workspace.js";
import { git, gitOut, initBareUpstream, initGitWorkspace, queueEnv, tempFixture, testEnv } from "../helpers.js";

function fixture(aliases: string[] = ["api"], missingBaseline?: string) {
  const cwd = realpathSync(initGitWorkspace());
  const bare = realpathSync(initBareUpstream({ branches: ["main", "shared"] }));
  const repos = aliases.map((alias) => ({ alias, branch: alias === missingBaseline ? "does-not-exist" : "main", remotes: { origin: `file://${bare}` } }));
  writeFileSync(join(cwd, "oms.yaml"), JSON.stringify({ repos }));
  git(cwd, "add", "oms.yaml");
  git(cwd, "commit", "-m", "independent sources");
  return { cwd, bare, dir: join(cwd, "oms/api"), repos };
}

function rootState(cwd: string) {
  return [gitOut(cwd, "rev-parse", "HEAD"), gitOut(cwd, "ls-files", "--stage")];
}

function provision(cwd: string, alias = "api") {
  const loaded = loadForSources({ cwd });
  assert.ok(loaded);
  const repo = loaded.repos.find((entry) => entry.alias === alias);
  assert.ok(repo);
  assert.equal(cloneSource(loaded.workspace, repo), "cloned");
  const dir = join(cwd, "oms", alias);
  git(dir, "config", "user.name", "Source Commands");
  git(dir, "config", "user.email", "source-commands@example.test");
  return dir;
}

async function run(cwd: string, action: () => Promise<number>, responses?: unknown[]) {
  const original = process.cwd();
  const env = { ...process.env };
  delete process.env.OMS_TEST_PROMPT_RESPONSES;
  Object.assign(process.env, responses === undefined ? testEnv : queueEnv(responses));
  __resetPromptQueueForTests();
  try {
    process.chdir(cwd);
    const code = await action();
    assertPromptQueueDrained();
    return code;
  } finally {
    process.chdir(original);
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    __resetPromptQueueForTests();
  }
}

test("fetch makes one missing-checkout decision, defaults wide requests to skip, and continues after a clone failure", async () => {
  const { cwd, bare, dir } = fixture(["api", "bad", "web"], "bad");
  provision(cwd);
  const before = rootState(cwd);
  git(bare, "branch", "created-after-clone");
  const branchNames = () => gitOut(dir, "for-each-ref", "--format=%(refname)", "refs/remotes/origin");

  assert.equal(await run(cwd, () => runSourceManage("fetch", [], { all: true }), [{ type: "cancel" }]), 1);
  assert.doesNotMatch(branchNames(), /created-after-clone/);
  const useDefault = [{ type: "select", default: true }];
  assert.equal(await run(cwd, () => runSourceManage("fetch", [], { all: true }), useDefault), 0);
  assert.match(branchNames(), /created-after-clone/);
  assert.ok(!existsSync(join(cwd, "oms/web")));

  assert.equal(await run(cwd, () => runSourceManage("fetch", ["bad", "web"], {}), useDefault), 2);
  assert.ok(!existsSync(join(cwd, "oms/bad")));
  assert.ok(existsSync(join(cwd, "oms/web/.git")));
  assert.deepEqual(rootState(cwd), before);
});

test("remove force refuses unpublished source history but can discard approved working files after publication", async () => {
  const { cwd, dir, bare } = fixture();
  provision(cwd);
  git(dir, "commit", "--allow-empty", "-m", "unpublished");
  const tip = gitOut(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "working.txt"), "working file");
  const root = rootState(cwd);
  const origin = gitOut(bare, "rev-parse", "refs/heads/main");
  const remove = () => runRemove(["api"], { yes: true, force: true });

  assert.equal(await run(cwd, remove), 2);
  assert.equal(gitOut(dir, "rev-parse", "HEAD"), tip);
  assert.equal(gitOut(dir, "status", "--porcelain"), "?? working.txt");
  assert.equal(gitOut(bare, "rev-parse", "refs/heads/main"), origin);

  git(dir, "push", "origin", "main");
  assert.equal(await run(cwd, remove), 0);
  assert.equal(existsSync(dir), false);
  assert.equal(gitOut(bare, "rev-parse", "refs/heads/main"), tip);
  assert.deepEqual(rootState(cwd), root);
});

test("commit, pull and push operate on one source; detached attachment and fast-forward safeguards hold", async () => {
  const { cwd, bare, dir } = fixture(["api", "absent"]);
  provision(cwd);
  writeFileSync(join(cwd, "root-staged"), "root work");
  git(cwd, "add", "root-staged");
  const before = rootState(cwd);
  git(dir, "switch", "--detach");
  writeFileSync(join(dir, "staged"), "staged");
  git(dir, "add", "staged");
  writeFileSync(join(dir, "leftover"), "unstaged");
  assert.equal(await run(dir, () => runSourceCommit(undefined, { message: ["staged only", "body"] })), 0);
  assert.equal(gitOut(dir, "branch", "--show-current"), "main");
  assert.equal(gitOut(dir, "show", "-s", "--format=%B"), "staged only\n\nbody");
  assert.equal(gitOut(dir, "status", "--porcelain"), "?? leftover");
  assert.equal(await run(cwd, () => runSourceManage("pull", ["api"], {})), 2);
  assert.equal(await run(cwd, () => runSourceManage("push", ["absent", "api"], {})), 2);
  assert.ok(!existsSync(join(cwd, "oms/absent")));
  assert.equal(gitOut(bare, "rev-parse", "main"), gitOut(dir, "rev-parse", "main"));
  rmSync(join(dir, "leftover"));

  const peer = tempFixture("source-peer-");
  git(peer, "clone", bare, ".");
  git(peer, "-c", "user.name=Peer", "-c", "user.email=peer@example.test", "commit", "--allow-empty", "-m", "remote update");
  git(peer, "push", "origin", "main");
  assert.equal(await run(cwd, () => runSourceManage("pull", ["api"], {})), 0);
  assert.equal(gitOut(dir, "rev-parse", "HEAD"), gitOut(peer, "rev-parse", "HEAD"));
  git(dir, "commit", "--allow-empty", "-m", "local divergence");
  const divergent = gitOut(dir, "rev-parse", "HEAD");
  git(peer, "-c", "user.name=Peer", "-c", "user.email=peer@example.test", "commit", "--allow-empty", "-m", "remote divergence");
  git(peer, "push", "origin", "main");
  assert.equal(await run(cwd, () => runSourceManage("pull", ["api"], {})), 2);
  assert.equal(gitOut(dir, "rev-parse", "HEAD"), divergent);
  assert.deepEqual(rootState(cwd), before);

  git(dir, "switch", "--detach");
  git(dir, "commit", "--allow-empty", "-m", "detached work");
  const detached = gitOut(dir, "rev-parse", "HEAD");
  assert.equal(await run(cwd, () => runSourceManage("push", ["api"], {})), 2);
  assert.equal(gitOut(dir, "rev-parse", "HEAD"), detached);
  assert.equal(gitOut(dir, "branch", "--show-current"), "");
  writeFileSync(join(dir, "attachment-choice"), "carry this file");
  assert.equal(await run(cwd, () => runSourceCommit("api", { message: ["explicit branch choice"] }), [{ type: "select", value: "main" }]), 0);
  assert.equal(gitOut(dir, "branch", "--show-current"), "main");
  assert.equal(gitOut(dir, "rev-parse", "HEAD^"), divergent);
  assert.deepEqual(rootState(cwd), before);
});

test("branch list infers the canonical source, switch creates local-only branches and checkout tracks origin", async () => {
  const { cwd, dir } = fixture(["api", "absent"]);
  provision(cwd);
  const before = rootState(cwd);
  assert.equal(await run(dir, () => runSourceBranchList(undefined)), 0);
  assert.equal(await run(dir, () => runSourceSwitch(undefined, "topic", { from: "origin/shared" })), 0);
  assert.equal(gitOut(dir, "for-each-ref", "--format=%(upstream)", "refs/heads/topic"), "");
  assert.equal(await run(cwd, () => runSourceCheckout("api", "shared")), 0);
  assert.equal(gitOut(dir, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/shared");
  assert.equal(await run(dir, () => runSourceBranchDelete(undefined, "topic", {})), 1);
  assert.equal(await run(cwd, () => runSourceBranchDelete("api", "main", { force: true })), 1);
  assert.equal(await run(cwd, () => runSourceBranchDelete("api", "topic", {})), 0);
  assert.equal(await run(cwd, () => runSourceBranchClean("absent", {}), []), 1);
  assert.ok(!existsSync(join(cwd, "oms/absent")));
  git(dir, "branch", "merged");
  assert.equal(await run(cwd, () => runSourceBranchClean("api", {}), [{ type: "confirm", value: true }]), 0);
  assert.equal(gitOut(dir, "for-each-ref", "--format=%(refname)", "refs/heads/merged"), "");
  assert.deepEqual(rootState(cwd), before);
});

test("cleanup never reads root pointers or clones during revalidation; changed candidate is preserved and replacement Git directory stops cleanup", () => {
  const { cwd, dir } = fixture();
  provision(cwd);
  git(dir, "branch", "a-moved");
  git(dir, "branch", "z-safe");
  git(dir, "branch", "m-occupied");
  const loaded = loadForSources({ cwd }, (path, args, input) => {
    assert.notEqual(args[0], "clone");
    if (path === cwd) assert.ok(!args.some((arg) => ["ls-files", "ls-tree", ".gitmodules"].includes(arg)), args.join(" "));
    return productionGitRunner(path, args, input);
  });
  assert.ok(loaded);
  const [repo] = loaded.repos;
  const eligible = loadForSources({ cwd });
  assert.ok(eligible);
  const checkout = inspectSourceCheckout(eligible.workspace, repo);
  assert.equal(checkout.kind, "ready");
  const plan = planSourceBranchClean(loaded.workspace, repo, checkout, undefined);
  git(dir, "commit", "--allow-empty", "-m", "new branch tip");
  git(dir, "branch", "-f", "a-moved", "HEAD");
  // Keep the approved comparison base unchanged while moving another branch.
  git(dir, "reset", "--hard", "HEAD^");
  git(dir, "worktree", "add", join(cwd, "external-tree"), "m-occupied");
  git(cwd, "commit", "--allow-empty", "-m", "unrelated root update");
  const first = executeSourceBranchClean(loaded.workspace, repo, plan);
  assert.deepEqual(first.map((outcome) => outcome.kind), ["preserved", "preserved", "deleted"]);
  assert.match(first[1].reason ?? "", /worktree/);

  git(dir, "branch", "replacement-proof");
  const second = planSourceBranchClean(loaded.workspace, repo, checkout, undefined);
  const oldGit = join(cwd, "saved-git");
  renameSync(join(dir, ".git"), oldGit);
  cpSync(oldGit, join(dir, ".git"), { recursive: true });
  const outcomes = executeSourceBranchClean(loaded.workspace, repo, second);
  assert.equal(outcomes[0].kind, "not run");
  assert.match(outcomes[0].reason ?? "", /checkout identity changed/);
  assert.ok(gitOut(dir, "rev-parse", "refs/heads/replacement-proof"));
});
