import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { analyzeManagedBlock, installManagedBlock } from "../../scripts/lib/agent.js";
import { formatCommand, globalUpdateCommand } from "../../scripts/lib/install-context.js";
import { classify, installedSkillVersion } from "../../scripts/lib/skills.js";
import {
  channelInstallCommand,
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

test("skill frontmatter parsing and version classification fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "oms-skill-unit-"));
  roots.push(root);
  const valid = join(root, "valid.md");
  const malformed = join(root, "malformed.md");
  writeFileSync(valid, "---\nname: oms-commit\nmetadata:\n  version: 1.2.3\n---\n");
  writeFileSync(malformed, "---\nname: oms-commit\nmetadata:\n  version: latest\n---\n");
  assert.equal(installedSkillVersion(valid), "1.2.3");
  assert.equal(installedSkillVersion(malformed), null);
  assert.equal(installedSkillVersion(join(root, "missing.md")), null);
  assert.equal(classify(null, "1.2.3"), "older");
  assert.equal(classify("1.2.2", "1.2.3"), "older");
  assert.equal(classify("1.2.3", "1.2.3"), "current");
  assert.equal(classify("1.3.0", "1.2.3"), "newer");
});
