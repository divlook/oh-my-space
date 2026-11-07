import assert from "node:assert/strict";
import test from "node:test";
import { analyzeManagedBlock, installManagedBlock } from "../../scripts/lib/agent.js";
test("agent marker installation creates, replaces, and rejects malformed managed blocks", () => {
  const created = installManagedBlock(null);
  assert.deepEqual(analyzeManagedBlock(created).kind, "valid");
  const appended = installManagedBlock("# Existing rules\n");
  assert.ok(appended.startsWith("# Existing rules\n"));
  const replaced = installManagedBlock("# Existing rules\n<!-- OMS START -->\nstale rule\n<!-- OMS END -->\n# Keep footer\n");
  assert.equal(analyzeManagedBlock(replaced).kind, "valid");
  assert.ok(replaced.startsWith("# Existing rules\n"));
  assert.ok(replaced.endsWith("# Keep footer\n"));
  assert.doesNotMatch(replaced, /stale rule/);
  assert.equal(installManagedBlock(replaced), replaced);
  assert.throws(() => installManagedBlock("<!-- OMS START -->\nmissing end\n"));
});
