import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { git, gitOut, initBareUpstream, initGitWorkspace, localBranchExists, sourceFor, sourcesFor, tempFixture, writeSources } from "../helpers.js";
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

test("cleanup refuses a missing checkout without provisioning or offering confirmation", async () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  const status = gitOut(cwd, "status", "--porcelain");
  const intercepted = wrapper("");
  const result = await clean(cwd, { responses: [], env: intercepted.env });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /oms clone api/);
  assert.doesNotMatch(result.output, /comparison base|Candidate:|Delete these/i);
  assert.doesNotMatch(readFileSync(intercepted.log, "utf8"), /^(?:clone|fetch) /m);
  assert.equal(existsSync(join(cwd, "oms", "api")), false);
  assert.equal(gitOut(cwd, "status", "--porcelain"), status);
});

test("cleanup preserves an independent checkout's head, baseline tracking and refs after decline", async () => {
  const { cwd, wt } = fixture();
  git(wt, "branch", "topic");
  const before = snapshot(cwd, wt);
  const result = await clean(cwd, { responses: [{ type: "confirm", value: false }] });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /declined or cancelled/);
  assert.deepEqual(snapshot(cwd, wt), before);
  assert.equal(gitOut(wt, "config", "branch.main.remote"), "origin");
  assert.equal(gitOut(wt, "config", "branch.main.merge"), "refs/heads/main");
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
    assert.doesNotMatch(result.output, /no eligible/i);
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
      if (kind === "protected") git(wt, "checkout", "a-first");
    });
    assert.deepEqual(outcomes.map((outcome) => outcome.kind), ["preserved", "deleted"], kind);
    assert.ok(localBranchExists(wt, "a-first"));
    assert.equal(localBranchExists(wt, "z-last"), false);
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

test("cleanup aborts remaining work when the base, declaration, checkout identity, origin or operation changes", async () => {
  for (const kind of ["base", "declaration", "identity", "origin", "operation"]) {
    const { cwd, wt, bare } = fixture();
    candidates(wt);
    git(wt, "commit", "--allow-empty", "-m", "advance base");
    const changedBase = gitOut(wt, "rev-parse", "HEAD");
    git(wt, "reset", "--hard", "HEAD^");
    const outcomes = executeAfterChange(cwd, () => {
      if (kind === "base") git(wt, "update-ref", "refs/heads/main", changedBase);
      if (kind === "identity") {
        renameSync(wt, `${wt}-original`);
        git(cwd, "clone", `file://${bare}`, "oms/api");
        candidates(wt);
      }
      if (kind === "declaration") writeSources(cwd, sourceFor("api", bare, "main", { backup: bare }));
      if (kind === "origin") git(wt, "remote", "set-url", "origin", `file://${initBareUpstream()}`);
      if (kind === "operation") writeFileSync(gitOut(wt, "rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"), `${gitOut(wt, "rev-parse", "HEAD")}\n`);
    });
    assert.deepEqual(outcomes.map((outcome) => outcome.kind), ["not run", "not run"], kind);
    assert.ok(localBranchExists(wt, "a-first") && localBranchExists(wt, "z-last"));
    if (kind === "identity") assert.ok(localBranchExists(`${wt}-original`, "a-first") && localBranchExists(`${wt}-original`, "z-last"));
    assert.ok(outcomes.every((outcome) => outcome.reason));
  }
});

test("cleanup ignores unrelated root commits, staged files and declarations", async () => {
  const { cwd, wt, bare } = fixture();
  candidates(wt);
  const marker = join(tempFixture("clean-unrelated-root-"), "after-plan");
  const intercepted = wrapper(`if [[ -f ${shell(marker)} && ( "$*" == *ls-tree* || "$*" == *ls-files* ) ]]; then echo unexpected-root-index-or-history-read >&2; exit 128; fi`);
  const outcomes = executeAfterChange(cwd, () => {
    writeSources(cwd, sourcesFor([{ alias: "api", bare }, { alias: "web", bare }]));
    writeFileSync(join(cwd, "unrelated"), "root change");
    git(cwd, "add", "unrelated");
    git(cwd, "commit", "-m", "unrelated root commit");
    writeFileSync(join(cwd, "staged"), "keep staged");
    git(cwd, "add", "staged");
    writeFileSync(marker, "armed");
  }, intercepted.env);
  assert.deepEqual(outcomes.map((outcome) => outcome.kind), ["deleted", "deleted"]);
  assert.equal(localBranchExists(wt, "a-first"), false);
  assert.equal(localBranchExists(wt, "z-last"), false);
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "staged");
});

test("cleanup shared inspection failures after confirmation abort all remaining candidates", async () => {
  for (const match of ["worktree list", "--is-shallow-repository", "merge-base --is-ancestor"]) {
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
