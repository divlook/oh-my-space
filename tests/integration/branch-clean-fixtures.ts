import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { runBranchClean } from "../../scripts/lib/branch-clean.js";
import { planBranchClean, executeBranchClean } from "../../scripts/lib/branch-clean-plan.js";
import { loadRepos } from "../../scripts/lib/manifest.js";
import { __resetPromptQueueForTests, assertPromptQueueDrained } from "../../scripts/lib/prompt-adapter.js";
import { git, gitOut, initBareUpstream, initGitWorkspace, queueEnv, syncedSubmodule, tempFixture, testEnv, workspaceWithApi } from "../helpers.js";

Object.assign(process.env, testEnv);
const yes = [{ type: "confirm", value: true }];
const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function fixture(base = "main") {
  if (base === "main") return workspaceWithApi();
  const bare = initBareUpstream({ branches: [base] });
  const cwd = initGitWorkspace();
  const wt = syncedSubmodule(cwd, "api", bare, base);
  return { bare, cwd, wt };
}
function snapshot(cwd: string, wt: string) {
  return { root: gitOut(cwd, "rev-parse", "HEAD"), rootIndex: gitOut(cwd, "ls-files", "--stage"), head: gitOut(wt, "rev-parse", "HEAD"), current: gitOut(wt, "branch", "--show-current"), index: gitOut(wt, "ls-files", "--stage"), status: gitOut(wt, "status", "--porcelain"), remotes: gitOut(wt, "for-each-ref", "refs/remotes", "--format=%(refname) %(objectname)") };
}
function candidates(wt: string) {
  git(wt, "branch", "a-first");
  git(wt, "branch", "z-last");
}
async function clean(cwd: string, options: { alias?: string; base?: string; responses?: unknown[]; env?: Record<string, string> } = {}) {
  const previous = { ...process.env };
  const oldCwd = process.cwd();
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  let output = "";
  const capture = (chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  };
  Object.assign(process.env, options.responses === undefined ? testEnv : queueEnv(options.responses), options.env);
  if (options.responses === undefined) delete process.env.OMS_TEST_PROMPT_RESPONSES;
  __resetPromptQueueForTests();
  process.stdout.write = capture as typeof stdout;
  process.stderr.write = capture as typeof stderr;
  try {
    process.chdir(cwd);
    const code = await runBranchClean(options.alias ?? "api", { base: options.base });
    if (code === 0) assertPromptQueueDrained();
    return { code, output };
  } finally {
    process.chdir(oldCwd);
    process.stdout.write = stdout;
    process.stderr.write = stderr;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    __resetPromptQueueForTests();
  }
}
function executeAfterChange(cwd: string, change: () => void, env: Record<string, string> = {}) {
  const previous = { ...process.env };
  Object.assign(process.env, env);
  try {
    const loaded = loadRepos({ cwd });
    assert.ok(loaded);
    const repo = loaded.repos.find((entry) => entry.alias === "api");
    assert.ok(repo);
    const plan = planBranchClean(loaded.repoRoot, repo, undefined);
    change();
    return executeBranchClean(loaded.repoRoot, repo, plan);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}
function wrapper(body: string) {
  const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const dir = tempFixture("clean-git-");
  const log = join(dir, "commands");
  const path = join(dir, "git");
  writeFileSync(path, `#!/usr/bin/env bash\nREAL=${shell(real)}\nprintf '%s\\n' "$*" >> ${shell(log)}\n${body}\nexec "$REAL" "$@"\n`);
  chmodSync(path, 0o755);
  return { env: { PATH: `${dir}${delimiter}${process.env.PATH}` }, log };
}

export { yes, shell, fixture, snapshot, candidates, clean, executeAfterChange, wrapper };
