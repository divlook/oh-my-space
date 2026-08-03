import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { analyzeManagedBlock, installManagedBlock } from "../../scripts/lib/agent.js";
import { selectBetaBaseVersion } from "../../scripts/lib/beta-release-plan.js";
import { formatCommand, globalUpdateCommand } from "../../scripts/lib/install-context.js";
import { channelInstallCommand, registryDistTagsFromJson } from "../../scripts/lib/package-channels.js";
import { validatePublishedSkillMetadata } from "../../scripts/lib/skill-metadata.js";
import {
  classifyCompatibility,
  classifyFreshness,
  classifySkillMetadata,
  installedSkillMetadata,
} from "../../scripts/lib/skills.js";
import {
  compareVersions,
  isPrereleaseVersion,
  latestFromRegistryJson,
} from "../../scripts/lib/update.js";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("update version and channel decisions reject malformed registry or semver inputs", () => {
  assert.equal(latestFromRegistryJson({ "dist-tags": { latest: "2.0.0" } }), "2.0.0");
  assert.throws(() => latestFromRegistryJson({ versions: [] }), /missing dist-tags\.latest/);
  assert.deepEqual(
    registryDistTagsFromJson({ "dist-tags": { latest: "1.0.0", beta: "2.0.0-beta.1" } }),
    { latest: "1.0.0", beta: "2.0.0-beta.1" },
  );
  assert.deepEqual(
    registryDistTagsFromJson({ "dist-tags": { latest: "1.0.0" } }),
    { latest: "1.0.0", beta: null },
  );
  assert.throws(
    () => registryDistTagsFromJson({ "dist-tags": { latest: "1.0.0", beta: "not-semver" } }),
    /invalid dist-tags\.beta/,
  );
  assert.equal(compareVersions("1.0.0", "2.0.0"), -1);
  assert.equal(compareVersions("2.0.0", "2.0.0"), 0);
  assert.throws(() => compareVersions("local", "2.0.0"), /not valid semver/);
  assert.equal(isPrereleaseVersion("2.0.0-beta.1"), true);
  assert.equal(isPrereleaseVersion("2.0.0"), false);
  assert.deepEqual(
    ["npm", "pnpm", "yarn", "bun"].map((manager) => channelInstallCommand(manager as "npm" | "pnpm" | "yarn" | "bun", "beta")),
    [
      "npm install -g oh-my-space@beta",
      "pnpm add -g oh-my-space@beta",
      "yarn global add oh-my-space@beta",
      "bun add -g oh-my-space@beta",
    ],
  );
});

test("install command selection preserves package-manager-specific executable and arguments", () => {
  assert.deepEqual(globalUpdateCommand("npm"), { executable: "npm", args: ["install", "-g", "oh-my-space@latest"] });
  assert.deepEqual(globalUpdateCommand("pnpm"), { executable: "pnpm", args: ["add", "-g", "oh-my-space@latest"] });
  assert.deepEqual(globalUpdateCommand("yarn"), { executable: "yarn", args: ["global", "add", "oh-my-space@latest"] });
  assert.deepEqual(globalUpdateCommand("bun"), { executable: "bun", args: ["add", "-g", "oh-my-space@latest"] });
  assert.equal(formatCommand({ executable: "pnpm", args: ["add", "-g", "oh-my-space@latest"] }), "pnpm add -g oh-my-space@latest");
});

test("agent marker installation creates, replaces, and rejects malformed managed blocks", () => {
  const created = installManagedBlock(null);
  assert.deepEqual(analyzeManagedBlock(created).kind, "valid");
  const appended = installManagedBlock("# Existing rules\n");
  assert.match(appended, /^# Existing rules\n\n\n<!-- OMS START -->/);
  const replaced = installManagedBlock(appended.replace("Run `oms status --json`", "stale rule"));
  assert.match(replaced, /Run `oms status --json`/);
  assert.doesNotMatch(replaced, /stale rule/);
  assert.deepEqual(analyzeManagedBlock("<!-- OMS START -->\nmissing end\n").kind, "malformed");
});

test("published skill metadata enforces quoted versions and an exact compatibility sentence", () => {
  const valid = `---
name: oms-commit
compatibility: Requires oh-my-space >=1.0.0-0.
metadata:
  version: "1.2.3"
  oh-my-space-version: ">=1.0.0-0"
---
`;
  assert.deepEqual(validatePublishedSkillMetadata(valid, "SKILL.md"), {
    version: "1.2.3",
    omsVersion: ">=1.0.0-0",
  });
  assert.deepEqual(validatePublishedSkillMetadata(`\uFEFF${valid}`, "SKILL.md"), {
    version: "1.2.3",
    omsVersion: ">=1.0.0-0",
  });
  assert.throws(
    () => validatePublishedSkillMetadata(valid.replace('  version: "1.2.3"\n', ""), "SKILL.md"),
    /metadata\.version/,
  );
  assert.throws(
    () => validatePublishedSkillMetadata(valid.replace('">=1.0.0-0"', "future"), "SKILL.md"),
    /metadata\.oh-my-space-version/,
  );
  assert.throws(
    () => validatePublishedSkillMetadata(valid.replace(">=1.0.0-0.", ">=2.0.0."), "SKILL.md"),
    /compatibility must exactly equal/,
  );
  assert.throws(
    () => validatePublishedSkillMetadata(valid.replace('"1.2.3"', "1.2.3"), "SKILL.md"),
    /quoted semver/,
  );
  assert.throws(
    () => validatePublishedSkillMetadata(valid.replace('">=1.0.0-0"', '""').replace(">=1.0.0-0.", "."), "SKILL.md"),
    /metadata\.oh-my-space-version/,
  );
  assert.throws(
    () => validatePublishedSkillMetadata(
      valid.replace('">=1.0.0-0"', '" >=1.0.0-0 "').replace(">=1.0.0-0.", " >=1.0.0-0 ."),
      "SKILL.md",
    ),
    /metadata\.oh-my-space-version/,
  );
  const shorthandRange = valid
    .replace(">=1.0.0-0.", "^1.0.0.")
    .replace('">=1.0.0-0"', '"^1.0.0"');
  assert.deepEqual(validatePublishedSkillMetadata(shorthandRange, "SKILL.md"), {
    version: "1.2.3",
    omsVersion: "^1.0.0",
  });
});

test("installed skill metadata and independent classifications fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "oms-skill-unit-"));
  roots.push(root);
  const valid = join(root, "valid.md");
  const malformed = join(root, "malformed.md");
  writeFileSync(valid, `---
name: oms-commit
metadata:
  version: "1.2.3"
  oh-my-space-version: ">=1.0.0-0"
---
`);
  writeFileSync(malformed, "---\nmetadata:\n  version: latest\n  oh-my-space-version: nope\n---\n");
  assert.deepEqual(installedSkillMetadata(valid), { version: "1.2.3", omsVersion: ">=1.0.0-0" });
  assert.deepEqual(installedSkillMetadata(malformed), { version: null, omsVersion: null });
  const emptyRange = join(root, "empty-range.md");
  writeFileSync(emptyRange, '---\nmetadata:\n  version: "1.2.3"\n  oh-my-space-version: " "\n---\n');
  assert.deepEqual(installedSkillMetadata(emptyRange), { version: "1.2.3", omsVersion: null });
  assert.deepEqual(installedSkillMetadata(join(root, "missing.md")), { version: null, omsVersion: null });
  assert.equal(classifyFreshness(null, "1.2.3"), "older");
  assert.equal(classifyFreshness(null, "1.2.3", false), "unverified");
  assert.equal(classifyFreshness("1.2.2", "1.2.3"), "older");
  assert.equal(classifyFreshness("1.2.3", "1.2.3"), "current");
  assert.equal(classifyFreshness("1.3.0", "1.2.3"), "newer");
  assert.equal(classifyCompatibility(null, "1.0.0"), "unverified");
  assert.equal(classifyCompatibility(">=1.0.0-0", "0.14.2"), "incompatible");
  assert.equal(classifyCompatibility(">=1.0.0-0", "1.0.0-beta.sha-test"), "compatible");
  assert.equal(classifyCompatibility(">=1.0.0-0", "1.0.0"), "compatible");
});

test("skill classification covers every freshness and compatibility pair", () => {
  const freshnessCases = [
    { version: "1.0.0", located: true, expected: "current" },
    { version: "0.9.0", located: true, expected: "older" },
    { version: "1.1.0", located: true, expected: "newer" },
    { version: null, located: false, expected: "unverified" },
  ] as const;
  const compatibilityCases = [
    { range: ">=0.1.0", expected: "compatible" },
    { range: ">=2.0.0", expected: "incompatible" },
    { range: null, expected: "unverified" },
  ] as const;

  for (const freshness of freshnessCases) {
    for (const compatibility of compatibilityCases) {
      assert.deepEqual(
        classifySkillMetadata(
          freshness.version,
          "1.0.0",
          compatibility.range,
          "1.0.0",
          freshness.located,
        ),
        { freshness: freshness.expected, compatibility: compatibility.expected },
      );
    }
  }
});

test("beta base selection rejects missing, ambiguous, prerelease, and non-forward plans", () => {
  assert.equal(
    selectBetaBaseVersion({ releases: [{ name: "oh-my-space", newVersion: "1.0.0" }] }, "0.14.2"),
    "1.0.0",
  );
  assert.throws(() => selectBetaBaseVersion({ releases: [] }, "0.14.2"), /pending Changeset release/);
  assert.throws(
    () => selectBetaBaseVersion({
      releases: [
        { name: "oh-my-space", newVersion: "1.0.0" },
        { name: "oh-my-space", newVersion: "1.1.0" },
      ],
    }, "0.14.2"),
    /expected exactly one/,
  );
  assert.throws(
    () => selectBetaBaseVersion({ releases: [{ name: "oh-my-space", newVersion: "1.0.0-beta.1" }] }, "0.14.2"),
    /non-stable/,
  );
  assert.throws(
    () => selectBetaBaseVersion({ releases: [{ name: "oh-my-space", newVersion: "1.0.0+build.1" }] }, "0.14.2"),
    /non-stable/,
  );
  assert.throws(
    () => selectBetaBaseVersion({ releases: [{ name: "oh-my-space", newVersion: "0.14.2" }] }, "0.14.2"),
    /must be greater/,
  );
});
