import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { temporaryBetaMetadata } from "../../scripts/verification/beta-metadata.mjs";

test("temporary beta metadata restores original bytes after callback rejection and a partial write failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "oms-beta-metadata-"));
  const previous = process.cwd();
  const pkg = '{"name":"oh-my-space","version":"1.2.3"}\n';
  const lock = '{"version":"1.2.3","packages":{"":{"version":"1.2.3"}}}\n';
  try {
    process.chdir(root);
    writeFileSync("package.json", pkg);
    writeFileSync("package-lock.json", lock);
    const failure = new Error("publication failed");
    await assert.rejects(temporaryBetaMetadata("2.0.0-beta.sha-abcdef0").run(async () => {
      assert.equal(JSON.parse(readFileSync("package.json", "utf8")).version, "2.0.0-beta.sha-abcdef0");
      assert.equal(JSON.parse(readFileSync("package-lock.json", "utf8")).packages[""].version, "2.0.0-beta.sha-abcdef0");
      throw failure;
    }), (error: unknown) => error === failure);
    assert.equal(readFileSync("package.json", "utf8"), pkg);
    assert.equal(readFileSync("package-lock.json", "utf8"), lock);

    const metadata = temporaryBetaMetadata("2.0.0-beta.sha-abcdef0");
    rmSync("package-lock.json");
    mkdirSync("package-lock.json");
    let called = false;
    await assert.rejects(metadata.run(async () => { called = true; }), { code: "EISDIR" });
    assert.equal(called, false);
    assert.equal(readFileSync("package.json", "utf8"), pkg);
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  }
});
