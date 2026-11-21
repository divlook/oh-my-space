import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runSourceCommit } from "../../scripts/lib/commit.js";
import { git, gitOut, workspaceWithApi } from "../helpers.js";

test("commit validates empty messages and infers the current alias in one Git journey", async () => {
  const { cwd, wt } = workspaceWithApi();
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
    assert.equal(await runSourceCommit("api", { message: [] }), 0);
    assert.match(output, /Nothing to commit for api/);

    output = "";
    writeFileSync(join(wt, "uncommitted.txt"), "pending\n");
    const headBefore = gitOut(wt, "rev-parse", "HEAD");
    assert.equal(await runSourceCommit("api", { message: [] }), 1);
    assert.match(output, /-m is required/);
    assert.equal(gitOut(wt, "rev-parse", "HEAD"), headBefore);
    assert.match(gitOut(wt, "status", "--porcelain"), /uncommitted\.txt/);
    process.chdir(wt);
    assert.equal(await runSourceCommit(undefined, { message: ["feat: inferred"] }), 0);
    assert.equal(gitOut(wt, "log", "-1", "--pretty=%s"), "feat: inferred");
    output = "";
    const rootHeadBefore = gitOut(cwd, "rev-parse", "HEAD");
    writeFileSync(join(wt, "new.txt"), "hi");
    assert.equal(await runSourceCommit("api", { message: ["feat: add login flow"] }), 0);
    assert.equal(gitOut(wt, "log", "-1", "--pretty=%s"), "feat: add login flow");
    assert.match(output, /committed [0-9a-f]+/);
    assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootHeadBefore);
    assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
    assert.equal(gitOut(cwd, "status", "--porcelain"), "");
    assert.doesNotMatch(output, /oms record/);

    output = "";
    writeFileSync(join(wt, "staged.txt"), "a");
    writeFileSync(join(wt, "left.txt"), "b");
    git(wt, "add", "staged.txt");
    assert.equal(await runSourceCommit("api", { message: ["feat: only staged"] }), 0);
    const committedFiles = gitOut(wt, "show", "--name-only", "--pretty=format:", "HEAD");
    assert.match(committedFiles, /staged\.txt/);
    assert.doesNotMatch(committedFiles, /left\.txt/);
    assert.match(gitOut(wt, "status", "--porcelain"), /left\.txt/);
    assert.match(output, /unstaged or untracked changes remain/);

    output = "";
    writeFileSync(join(wt, "f.txt"), "x");
    assert.equal(
      await runSourceCommit("api", { message: ["feat: add login", "Add callback handling."] }),
      0,
    );
    const body = gitOut(wt, "log", "-1", "--pretty=%B");
    assert.match(body, /feat: add login/);
    assert.match(body, /Add callback handling\./);
  } finally {
    process.chdir(originalCwd);
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
});
