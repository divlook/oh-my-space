import assert from "node:assert/strict";
import test from "node:test";
import {
  currentBranch,
  inspectLocalBranches,
  inspectRemoteBranches,
  isDirty,
  parseGitVersion,
  redactSensitiveUrls,
  resolveOriginHead,
  runGit,
  runSub,
  type RawGitRunner,
} from "../../scripts/lib/git.js";
import type { GitResult } from "../../scripts/lib/types.js";

function queuedRunner(results: GitResult[], calls: Array<{ cwd: string; args: string[]; input?: Buffer | null }> = []): RawGitRunner {
  return (cwd, args, input) => {
    calls.push({ cwd, args, input });
    const result = results.shift();
    assert.ok(result, `unexpected Git call: ${args.join(" ")}`);
    return result;
  };
}

const ok = (stdout = ""): GitResult => ({ exitCode: 0, success: true, stdout, stderr: "" });
const failed = (stderr = "failure"): GitResult => ({ exitCode: 1, success: false, stdout: "", stderr });

test("raw Git runner receives exact cwd, arguments, and submodule path", () => {
  const calls: Array<{ cwd: string; args: string[]; input?: Buffer | null }> = [];
  const runner = queuedRunner([ok("main\n"), ok()], calls);

  assert.deepEqual(runGit("/repo", ["status"], false, undefined, runner), ok("main\n"));
  assert.deepEqual(runSub("/repo", "api", ["fetch"], false, runner), ok());
  assert.deepEqual(calls, [
    { cwd: "/repo", args: ["status"], input: undefined },
    { cwd: "/repo/oms/api", args: ["fetch"], input: undefined },
  ]);
});

test("branch and dirty classifiers consume raw Git outcomes without a process", () => {
  assert.equal(currentBranch("/repo", queuedRunner([ok("main\n")])), "main");
  assert.equal(currentBranch("/repo", queuedRunner([ok("HEAD\n")])), null);
  assert.equal(currentBranch("/repo", queuedRunner([failed()])), null);
  assert.equal(isDirty("/repo", queuedRunner([ok(" M source.ts\n")])), true);
  assert.equal(isDirty("/repo", queuedRunner([ok("\n")])), false);
  assert.equal(isDirty("/repo", queuedRunner([failed()])), false);

  assert.equal(resolveOriginHead("/repo", queuedRunner([ok("origin/main\n"), ok()])), "main");
  assert.equal(resolveOriginHead("/repo", queuedRunner([ok("origin/main\n"), failed()])), null);
});

test("local branch inspection parses upstream divergence and degrades malformed counts", () => {
  const result = inspectLocalBranches("/repo", queuedRunner([
    ok("feature\torigin/feature\nmain\t\n"),
    ok("2 3\n"),
  ]));
  assert.deepEqual(result, {
    ok: true,
    branches: [
      { name: "feature", upstream: "origin/feature", ahead: 2, behind: 3 },
      { name: "main", upstream: null, ahead: null, behind: null },
    ],
  });

  assert.deepEqual(
    inspectLocalBranches("/repo", queuedRunner([ok("feature\torigin/feature\n"), ok("bad\n")])),
    { ok: true, branches: [{ name: "feature", upstream: "origin/feature", ahead: null, behind: null }] },
  );
});

test("remote branch inspection sorts names, removes symbolic HEAD, and redacts failures", () => {
  assert.deepEqual(
    inspectRemoteBranches("/repo", "origin", queuedRunner([ok([
      "refs/remotes/origin/zeta",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/alpha",
      "",
    ].join("\n"))])),
    { ok: true, branches: ["alpha", "zeta"] },
  );
  assert.deepEqual(
    inspectRemoteBranches("/repo", "origin", queuedRunner([failed("https://user:secret@example.com/repo?token=value")])),
    { ok: false, diagnostic: "https://[redacted]@example.com/repo?token=[redacted]" },
  );
});

test("Git version and sensitive URL parsers reject malformed input without leaking credentials", () => {
  assert.deepEqual(parseGitVersion("git version 2.50.1"), { major: 2, minor: 50 });
  assert.equal(parseGitVersion("unknown"), null);
  assert.equal(
    redactSensitiveUrls("https://alice:secret@example.com/a?access_token=abc&safe=yes"),
    "https://[redacted]@example.com/a?access_token=[redacted]&safe=yes",
  );
});
