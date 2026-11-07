import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture, recordCurrent, runPrepack } from "./prepack-fixtures.js";

test("missing, malformed, and forced verification run the canonical suite before rebuilding", () => {
  for (const mode of ["missing", "malformed", "forced"] as const) {
    const { root, env, capture } = fixture();
    if (mode === "malformed") writeFileSync(join(root, ".oms-verification.json"), "{");
    if (mode === "forced") recordCurrent(root, env);
    const result = runPrepack(root, mode === "forced" ? { ...env, OMS_FORCE_TEST: "1" } : env);
    assert.equal(result.status, 0, `${mode}: ${result.stdout}${result.stderr}`);
    assert.deepEqual(readFileSync(capture, "utf8").trim().split("\n"), ["test", "run build"], mode);
  }
});
