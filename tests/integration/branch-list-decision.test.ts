import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { runBranchList } from "../../scripts/lib/branch-list.js";
import {
  git,
  initBareUpstream,
  initGitWorkspace,
  sourceFor,
  syncedSubmodule,
  writeSources,
} from "../helpers.js";

async function listBranches(cwd: string, alias?: string): Promise<{ code: number; output: string }> {
  const originalCwd = process.cwd();
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let output = "";
  const capture = (chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  };
  process.stdout.write = capture as typeof process.stdout.write;
  process.stderr.write = capture as typeof process.stderr.write;
  try {
    process.chdir(cwd);
    return { code: await runBranchList(alias), output };
  } finally {
    process.chdir(originalCwd);
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

test("branch list sorts local and declared remote branches while excluding unmanaged remotes", async () => {
  const origin = initBareUpstream({ branches: ["main", "zeta", "alpha"] });
  const backup = initBareUpstream({ branches: ["main", "beta"] });
  const unmanaged = initBareUpstream({ branches: ["main", "private"] });
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", origin);
  writeSources(cwd, sourceFor("api", origin, "main", { backup }));
  git(dir, "branch", "z-local");
  git(dir, "branch", "a-local");
  git(dir, "remote", "add", "unmanaged", `file://${unmanaged}`);
  git(dir, "fetch", "unmanaged");
  git(dir, "branch", "external", "unmanaged/private");
  git(dir, "branch", "--set-upstream-to", "unmanaged/private", "external");

  const result = await listBranches(cwd, "api");
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Branch inventory: api/);
  assert.ok(result.output.indexOf("a-local\t") < result.output.indexOf("main\t"), result.output);
  assert.ok(result.output.indexOf("main\t") < result.output.indexOf("z-local\t"), result.output);
  assert.match(result.output, /origin\tfresh\talpha/);
  assert.match(result.output, /backup\tfresh\tbeta/);
  assert.match(result.output, /external\t\tunmanaged\/private\t0\t0/);
  assert.doesNotMatch(result.output, /origin\/(?:HEAD)|\tunmanaged\t|unmanaged\t(?:fresh|stale|unavailable)/);
});

test("branch list reports baselines, upstream divergence, and missing upstream state", async () => {
  const origin = initBareUpstream({ branches: ["main", "develop", "tracked"] });
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", origin, "main");
  git(dir, "checkout", "-b", "tracked", "origin/tracked");
  git(dir, "commit", "--allow-empty", "-m", "ahead");
  git(dir, "branch", "ahead");
  git(dir, "branch", "--set-upstream-to", "origin/tracked", "ahead");
  git(dir, "branch", "scratch");
  git(dir, "config", "branch.tracked.merge", "refs/heads/missing");
  git(cwd, "config", "--file", ".gitmodules", "submodule.oms/api.branch", "develop");

  const result = await listBranches(cwd, "api");
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /BASELINE \[incomplete\]: develop, main|BASELINE \[incomplete\]: main, develop/);
  assert.match(result.output, /main\tbaseline/);
  assert.match(result.output, /ahead\t\torigin\/tracked\t1\t0/);
  assert.match(result.output, /tracked\tcurrent\torigin\/missing\t\?\t\?/);
  assert.match(result.output, /scratch\t\t\t\t/);
  assert.match(result.output, /differs from oms.yaml/);
});

