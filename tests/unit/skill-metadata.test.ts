import assert from "node:assert/strict";
import test from "node:test";
import { validatePublishedSkillMetadata } from "../../scripts/lib/skill-metadata.js";
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
