import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { configIdentity, git, gitOut, localBranchExists, sourceFor, sourcesFor, tempFixture, testEnv, workspaceWithApi, writeSources } from "../helpers.js";
import { shell, fixture, snapshot, candidates, clean, executeAfterChange, wrapper } from "./branch-clean-fixtures.js";

test("cleanup declines cancels and refuses noninteractive candidates but succeeds without candidates", async () => {
  const { cwd, wt } = fixture();
  const before = snapshot(cwd, wt);
  const empty = await clean(cwd, { responses: [] });
  assert.equal(empty.code, 0, empty.output);
  assert.match(empty.output, /api/);
  assert.doesNotMatch(empty.output, /comparison base|refs\/heads\/|Candidate:|Excluded:|Preparation|transactions|Delete these/i);
  assert.deepEqual(snapshot(cwd, wt), before);
  git(wt, "branch", "topic");
  for (const responses of [undefined, [{ type: "confirm", value: false }], [{ type: "cancel" }]]) {
    const result = await clean(cwd, { responses });
    assert.equal(result.code, 1, result.output);
    assert.ok(localBranchExists(wt, "topic"));
    assert.ok(result.output.includes(gitOut(wt, "rev-parse", "topic")));
  }
});

test("cleanup initialization followed by no candidates reports retained preparation", async () => {
  const original = workspaceWithApi();
  const cwd = tempFixture("clean-empty-uninitialized-");
  execFileSync("git", ["clone", original.cwd, cwd], { env: testEnv, stdio: "ignore" });
  configIdentity(cwd);
  const root = gitOut(cwd, "rev-parse", "HEAD");
  const rootIndex = gitOut(cwd, "ls-files", "--stage");
  const result = await clean(cwd, { responses: [] });
  const wt = join(cwd, "oms", "api");
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /initialized.*registered source/i);
  assert.doesNotMatch(result.output, /comparison base|Candidate:|Excluded:|transactions|Delete these/i);
  assert.equal(gitOut(wt, "branch", "--show-current"), "main");
  assert.equal(gitOut(wt, "rev-parse", "HEAD"), gitOut(cwd, "rev-parse", "HEAD:oms/api"));
  assert.equal(gitOut(wt, "config", "branch.main.remote"), "origin");
  assert.equal(gitOut(wt, "config", "branch.main.merge"), "refs/heads/main");
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), root);
  assert.equal(gitOut(cwd, "ls-files", "--stage"), rootIndex);
});

test("cleanup retains registered initialization baseline attachment and tracking after decline", async () => {
  const original = workspaceWithApi();
  git(original.wt, "branch", "topic");
  git(original.wt, "push", "origin", "topic");
  const cwd = tempFixture("clean-uninitialized-");
  execFileSync("git", ["clone", original.cwd, cwd], { env: testEnv, stdio: "ignore" });
  configIdentity(cwd);
  const wt = join(cwd, "oms", "api");
  const root = gitOut(cwd, "ls-files", "--stage");
  const interception = wrapper(`if [[ "$*" == *"worktree list"* ]] && [[ ! -f ${shell(join(cwd, "injected"))} ]]; then "$REAL" -C ${shell(wt)} branch topic origin/topic; touch ${shell(join(cwd, "injected"))}; fi`);
  const result = await clean(cwd, { responses: [{ type: "confirm", value: false }], env: interception.env });
  assert.equal(result.code, 1, result.output);
  assert.ok(existsSync(join(wt, ".git")));
  assert.equal(gitOut(wt, "branch", "--show-current"), "main");
  assert.equal(gitOut(wt, "rev-parse", "HEAD"), gitOut(cwd, "rev-parse", "HEAD:oms/api"));
  assert.equal(gitOut(wt, "config", "branch.main.remote"), "origin");
  assert.equal(gitOut(wt, "config", "branch.main.merge"), "refs/heads/main");
  assert.equal(gitOut(cwd, "ls-files", "--stage"), root);
  assert.ok(localBranchExists(wt, "topic"));
});

test("cleanup planning inspection errors fail closed instead of becoming idle detached or empty inventory", async () => {
  for (const match of ["for-each-ref", "worktree list", "merge-base --is-ancestor", "--is-shallow-repository", "symbolic-ref", "--git-path"]) {
    const { cwd, wt } = fixture();
    candidates(wt);
    const intercepted = wrapper(`if [[ "$*" == *${shell(match)}* ]]; then echo inspection-failure >&2; exit 128; fi`);
    const result = await clean(cwd, { env: intercepted.env });
    assert.notEqual(result.code, 0, `${match}: ${result.output}`);
    assert.ok(localBranchExists(wt, "a-first") && localBranchExists(wt, "z-last"), match);
    assert.doesNotMatch(result.output, /no eligible|no initialization was needed/i);
  }
});

test("cleanup preserves changed occupied symbolic and newly protected candidates and continues safe branches", async () => {
  for (const kind of ["tip", "occupied", "symbolic", "protected"]) {
    const { cwd, wt } = fixture();
    candidates(wt);
    git(wt, "commit", "--allow-empty", "-m", "base ahead");
    const outcomes = executeAfterChange(cwd, () => {
      if (kind === "tip") git(wt, "update-ref", "refs/heads/a-first", gitOut(wt, "rev-parse", "main"));
      if (kind === "occupied") git(wt, "worktree", "add", join(tempFixture("clean-occupied-"), "tree"), "a-first");
      if (kind === "symbolic") { git(wt, "update-ref", "-d", "refs/heads/a-first"); git(wt, "symbolic-ref", "refs/heads/a-first", "refs/heads/main"); }
      if (kind === "protected") git(cwd, "config", "-f", ".gitmodules", "submodule.oms/api.branch", "a-first");
    });
    assert.equal(outcomes[0]?.kind, kind === "protected" ? "not run" : "preserved", kind);
    assert.ok(localBranchExists(wt, "a-first"));
    assert.equal(localBranchExists(wt, "z-last"), kind === "protected");
  }
});

test("cleanup treats same-name same-OID recreation as confirmed and already absent as successful", async () => {
  for (const recreate of [false, true]) {
    const { cwd, wt } = fixture();
    candidates(wt);
    const tip = gitOut(wt, "rev-parse", "a-first");
    const outcomes = executeAfterChange(cwd, () => {
      git(wt, "update-ref", "-d", "refs/heads/a-first");
      if (recreate) git(wt, "branch", "a-first", tip);
      git(wt, "branch", "new-after-plan", tip);
    });
    assert.deepEqual(outcomes.map((outcome) => outcome.kind), [recreate ? "deleted" : "already absent", "deleted"]);
    assert.equal(localBranchExists(wt, "a-first"), false);
    assert.equal(localBranchExists(wt, "z-last"), false);
    assert.ok(localBranchExists(wt, "new-after-plan"));
  }
});

test("cleanup aborts remaining work on base selected declaration registration recorded commit or operation changes", async () => {
  for (const kind of ["base", "declaration", "registration", "recorded", "operation"]) {
    const { cwd, wt, bare } = fixture();
    candidates(wt);
    git(wt, "commit", "--allow-empty", "-m", "available changed pointer");
    const changedPointer = gitOut(wt, "rev-parse", "HEAD");
    git(wt, "reset", "--hard", "HEAD^");
    const outcomes = executeAfterChange(cwd, () => {
      if (kind === "base") git(wt, "update-ref", "refs/heads/main", changedPointer);
      if (kind === "recorded") {
        git(cwd, "update-index", "--cacheinfo", `160000,${changedPointer},oms/api`);
        git(cwd, "commit", "-m", "record changed");
      }
      if (kind === "declaration") writeSources(cwd, sourceFor("api", bare, "main", { backup: bare }));
      if (kind === "registration") git(cwd, "config", "-f", ".gitmodules", "submodule.oms/api.url", "file:///changed");
      if (kind === "operation") writeFileSync(gitOut(wt, "rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"), `${gitOut(wt, "rev-parse", "HEAD")}\n`);
    });
    assert.deepEqual(outcomes.map((outcome) => outcome.kind), ["not run", "not run"], kind);
    assert.ok(localBranchExists(wt, "a-first") && localBranchExists(wt, "z-last"));
    assert.ok(outcomes.every((outcome) => outcome.reason));
  }
});

test("cleanup ignores unrelated root commits declarations and staged source pointer movement", async () => {
  const { cwd, wt, bare } = fixture();
  candidates(wt);
  git(wt, "commit", "--allow-empty", "-m", "available staged pointer");
  const stagedPointer = gitOut(wt, "rev-parse", "HEAD");
  git(wt, "reset", "--hard", "HEAD^");
  const outcomes = executeAfterChange(cwd, () => {
    writeSources(cwd, sourcesFor([{ alias: "api", bare }, { alias: "web", bare }]));
    writeFileSync(join(cwd, "unrelated"), "root change");
    git(cwd, "add", "unrelated");
    git(cwd, "commit", "-m", "unrelated root commit");
    git(cwd, "update-index", "--cacheinfo", `160000,${stagedPointer},oms/api`);
  });
  assert.deepEqual(outcomes.map((outcome) => outcome.kind), ["deleted", "deleted"]);
  assert.equal(localBranchExists(wt, "a-first"), false);
  assert.equal(localBranchExists(wt, "z-last"), false);
});

test("cleanup shared inspection failures after confirmation abort all remaining candidates", async () => {
  for (const match of ["ls-tree", "ls-files", "worktree list", "merge-base --is-ancestor"]) {
    const { cwd, wt } = fixture();
    candidates(wt);
    const marker = join(tempFixture("clean-inspect-race-"), "armed");
    const intercepted = wrapper(`if [[ -f ${shell(marker)} && "$*" == *${shell(match)}* ]]; then echo shared-inspection-failure >&2; exit 128; fi`);
    const outcomes = executeAfterChange(cwd, () => writeFileSync(marker, "armed"), intercepted.env);
    assert.deepEqual(outcomes.map((outcome) => outcome.kind), ["not run", "not run"], match);
    assert.ok(localBranchExists(wt, "a-first") && localBranchExists(wt, "z-last"));
    assert.ok(outcomes.every((outcome) => outcome.reason?.includes("shared-inspection-failure")));
  }
});
