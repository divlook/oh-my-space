import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runDoctor } from "../../scripts/lib/doctor.js";
import { currentVersion, initGitWorkspace, testEnv, writeSources } from "../helpers.js";

Object.assign(process.env, testEnv);
const reference = JSON.stringify({
  "oms-workspace": { version: currentVersion, omsVersion: ">=1.0.0-0" },
  "oms-pointer": { version: currentVersion, omsVersion: ">=1.0.0-0" },
  "oms-branch": { version: currentVersion, omsVersion: ">=1.0.0-0" },
});

function skillsHome(): string {
  const home = mkdtempSync(join(tmpdir(), "oms-doctor-failure-"));
  const skillDir = join(home, ".claude", "skills", "oms-branch");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: oms-branch\ndescription: fixture\nmetadata:\n  author: oh-my-space\n  version: "${currentVersion}"\n  oh-my-space-version: ">=2.0.0-0"\n---\n\nbody\n`);
  mkdirSync(join(home, ".agents"), { recursive: true });
  writeFileSync(join(home, ".agents", ".skill-lock.json"), JSON.stringify({
    version: 3,
    skills: { "oms-branch": { source: "divlook/oh-my-space", sourceType: "github" } },
  }));
  return home;
}

async function doctor(cwd: string, home: string, overrides: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
  const keys = [
    "OMS_TEST_MODE",
    "OMS_TEST_SKILLS_HOME",
    "OMS_TEST_SKILL_REFERENCES",
    "OMS_TEST_PACKAGE_VERSION",
    "OMS_TEST_REGISTRY_RESPONSE",
    "OMS_TEST_REGISTRY_FAILURE",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
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
  Object.assign(process.env, {
    OMS_TEST_MODE: "1",
    OMS_TEST_SKILLS_HOME: home,
    OMS_TEST_SKILL_REFERENCES: reference,
    OMS_TEST_PACKAGE_VERSION: currentVersion,
    ...overrides,
  });
  try {
    process.chdir(cwd);
    return { code: await runDoctor(), output };
  } finally {
    process.chdir(originalCwd);
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("doctor keeps skill-channel lookup failures informational", async () => {
  const cwd = initGitWorkspace();
  writeSources(cwd);
  const home = skillsHome();
  try {
    const noMatch = await doctor(cwd, home, {
      OMS_TEST_REGISTRY_RESPONSE: JSON.stringify({ "dist-tags": { latest: "1.0.0", beta: "1.1.0-beta.1" } }),
    });
    assert.equal(noMatch.code, 0, noMatch.output);
    assert.match(noMatch.output, /no compatible published OMS channel was found/);

    for (const overrides of [
      { OMS_TEST_REGISTRY_RESPONSE: JSON.stringify({ "dist-tags": { latest: "1.0.0", beta: "not-semver" } }) },
      { OMS_TEST_REGISTRY_FAILURE: "registry timeout" },
    ]) {
      const failedLookup = await doctor(cwd, home, overrides);
      assert.equal(failedLookup.code, 0, failedLookup.output);
      assert.match(failedLookup.output, /Could not resolve compatible npm channels/);
      assert.match(failedLookup.output, /npm view oh-my-space dist-tags/);
      assert.match(failedLookup.output, /oh-my-space@latest/);
      assert.match(failedLookup.output, /oh-my-space@beta/);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
