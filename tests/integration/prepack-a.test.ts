import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fixture, recordCurrent, runPrepack } from "./prepack-fixtures.js";

test("matching verification rebuilds without rerunning canonical tests", () => {
  const { root, env, capture } = fixture();
  recordCurrent(root, env);
  for (const verbose of [false, true]) {
    const result = runPrepack(root, verbose ? { ...env, OMS_VERIFICATION_VERBOSE: "1" } : env);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  assert.deepEqual(readFileSync(capture, "utf8").trim().split("\n"), ["run build", "run build"]);
});
