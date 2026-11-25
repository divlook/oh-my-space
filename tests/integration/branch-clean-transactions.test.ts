import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { git, gitOut, initBareUpstream, localBranchExists, tempFixture, testEnv } from "../helpers.js";
import { yes, shell, fixture, candidates, clean, wrapper } from "./branch-clean-fixtures.js";

test("cleanup expected-tip and expected-base transactions reject races without force retries", async () => {
  for (const moved of ["a-first", "main"]) {
    const { cwd, wt } = fixture();
    candidates(wt);
    git(wt, "commit", "--allow-empty", "-m", "other OID");
    const other = gitOut(wt, "rev-parse", "HEAD");
    git(wt, "reset", "--hard", "HEAD^");
    const once = join(tempFixture("clean-race-"), "once");
    const intercepted = wrapper(`if [[ "$*" == *update-ref* && "$*" == *--stdin* && ! -f ${shell(once)} ]]; then touch ${shell(once)}; "$REAL" -C ${shell(wt)} update-ref ${shell(`refs/heads/${moved}`)} ${shell(other)}; fi`);
    const result = await clean(cwd, { responses: yes, env: intercepted.env });
    assert.equal(result.code, 2, result.output);
    assert.equal(gitOut(wt, "rev-parse", moved), other);
    assert.equal(localBranchExists(wt, "z-last"), moved === "main", result.output);
    assert.doesNotMatch(readFileSync(intercepted.log, "utf8"), /branch -[dD]|--force/);
  }
});

test("cleanup candidate-local ref and config failures retain accurate partial outcomes and recovery guidance", async () => {
  for (const failure of ["ref", "config"]) {
    const { cwd, wt } = fixture();
    candidates(wt);
    git(wt, "config", "branch.a-first.description", "candidate config");
    git(wt, "config", "branch.z-last.description", "later config");
    const tip = gitOut(wt, "rev-parse", "a-first");
    const once = join(tempFixture("clean-failure-"), "once");
    const body = failure === "ref"
      ? `if [[ "$*" == *update-ref* && "$*" == *--stdin* && ! -f ${shell(once)} ]]; then touch ${shell(once)}; cat >/dev/null; echo candidate-ref-failure >&2; exit 128; fi`
      : 'if [[ "$*" == *config* && "$*" == *--remove-section* && "$*" == *branch.a-first* ]]; then echo candidate-config-failure >&2; exit 128; fi';
    const intercepted = wrapper(body);
    const result = await clean(cwd, { responses: yes, env: intercepted.env });
    assert.equal(result.code, 2, result.output);
    assert.equal(localBranchExists(wt, "a-first"), failure === "ref");
    assert.equal(localBranchExists(wt, "z-last"), false);
    assert.equal(gitOut(wt, "config", "branch.a-first.description"), "candidate config");
    assert.ok(result.output.includes(tip), result.output);
    assert.match(result.output, /git.*branch/);
    if (failure === "config") assert.match(result.output, /--remove-section.*branch\.a-first/);
  }
});

test("cleanup emits executable shell-safe recreation and exact configuration repair commands", async () => {
  const { cwd, wt } = fixture();
  const branch = "topic'quoted";
  git(wt, "branch", branch);
  git(wt, "config", `branch.${branch}.description`, "repair");
  const tip = gitOut(wt, "rev-parse", branch);
  const intercepted = wrapper('if [[ "$*" == *config* && "$*" == *--remove-section* ]]; then echo config-failure >&2; exit 128; fi');
  const result = await clean(cwd, { responses: yes, env: intercepted.env });
  assert.equal(result.code, 2, result.output);
  const commands = result.output.match(/git -C [^\n\r]+/g) ?? [];
  const recreate = commands.find((command) => command.includes(" branch -- "));
  const repair = commands.find((command) => command.includes(" config --local --remove-section "));
  assert.ok(recreate && repair, result.output);
  execFileSync("/bin/sh", ["-c", recreate], { cwd: wt, env: testEnv });
  execFileSync("/bin/sh", ["-c", repair], { cwd: wt, env: testEnv });
  assert.equal(gitOut(wt, "rev-parse", branch), tip);
  assert.equal(spawnSync("git", ["-C", wt, "config", "--get", `branch.${branch}.description`], { env: testEnv }).status, 1);
});

test("cleanup refuses a foreign checkout without attempting mutation", async () => {
  const { cwd, wt } = fixture();
  candidates(wt);
  git(wt, "remote", "set-url", "origin", `file://${initBareUpstream()}`);
  const intercepted = wrapper("");
  const refused = await clean(cwd, { responses: [], env: intercepted.env });
  assert.equal(refused.code, 1, refused.output);
  assert.match(refused.output, /origin does not match.*declaration/);
  assert.doesNotMatch(readFileSync(intercepted.log, "utf8"), /^(?:clone|update-ref|branch -[dD]|config --local --remove-section) /m);
  assert.ok(localBranchExists(wt, "a-first") && localBranchExists(wt, "z-last"));
});
