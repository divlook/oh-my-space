import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { installedSkillMetadata } from "../../scripts/lib/skill-discovery.js";
const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("installed skill metadata fails closed for unreadable and invalid files", () => {
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
});
