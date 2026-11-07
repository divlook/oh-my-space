import assert from "node:assert/strict";
import test from "node:test";
import { classifyFreshness, classifyCompatibility } from "../../scripts/lib/skill-classification.js";
test("skill classifications distinguish missing, unknown, outdated, and prerelease-compatible metadata", () => {
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
