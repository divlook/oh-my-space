import assert from "node:assert/strict";
import test from "node:test";
import { readVerificationRecord } from "../../scripts/verification/record.mjs";
import { fixture, recordCurrent, runPrepack } from "./prepack-fixtures.js";

test("artifact version failure blocks packaging and invalidates the matching record", () => {
  const { root, env } = fixture();
  recordCurrent(root, env);
  const result = runPrepack(root, { ...env, OMS_TEST_ARTIFACT_VERSION: "9.9.9" });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /does not match package version/);
  assert.equal(readVerificationRecord(root), null);
});
