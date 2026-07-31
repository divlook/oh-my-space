import assert from "node:assert/strict";
import test from "node:test";
import {
  parseVerificationRecord,
  recordMatches,
  verificationKey,
} from "../../scripts/verification/record.mjs";

const environment = {
  node: "v24.0.0",
  git: "git version 2.50.0",
  os: "Darwin",
  osVersion: "25.0.0",
  arch: "arm64",
};

test("verification records require a supported schema and a self-consistent exact key", () => {
  const fingerprint = "a".repeat(64);
  const valid = {
    schema: 1,
    key: verificationKey(fingerprint, environment),
    fingerprint,
    environment,
    verifiedAt: "2026-07-31T00:00:00.000Z",
    command: "npm test",
  };

  assert.deepEqual(parseVerificationRecord(JSON.stringify(valid)), valid);
  assert.equal(parseVerificationRecord("{"), null);
  assert.equal(parseVerificationRecord(JSON.stringify({ ...valid, schema: 2 })), null);
  assert.equal(parseVerificationRecord(JSON.stringify({ ...valid, fingerprint: "b".repeat(64) })), null);
});

test("verification matches separate content and every environment identity field", () => {
  const fingerprint = "c".repeat(64);
  const record = {
    schema: 1,
    key: verificationKey(fingerprint, environment),
    fingerprint,
    environment,
    verifiedAt: "2026-07-31T00:00:00.000Z",
    command: "npm test",
  };

  assert.equal(recordMatches(record, fingerprint, environment), true);
  assert.equal(recordMatches(record, "d".repeat(64), environment), false);
  for (const key of Object.keys(environment) as Array<keyof typeof environment>) {
    assert.equal(recordMatches(record, fingerprint, { ...environment, [key]: `${environment[key]}-other` }), false, key);
  }
});
