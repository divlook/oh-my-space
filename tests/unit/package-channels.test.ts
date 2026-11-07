import assert from "node:assert/strict";
import test from "node:test";
import { channelInstallCommand, latestFromRegistryJson, registryDistTagsFromJson } from "../../scripts/lib/package-channels.js";
import { compareVersions, isPrereleaseVersion } from "../../scripts/lib/update.js";
test("update version and channel decisions reject malformed registry or semver inputs", () => {
  assert.equal(latestFromRegistryJson({ "dist-tags": { latest: "2.0.0" } }), "2.0.0");
  for (const data of [null, undefined, false, 1, "response", []]) {
    assert.throws(() => latestFromRegistryJson(data), /not a JSON object$/);
    assert.throws(() => registryDistTagsFromJson(data), /not a JSON object with dist-tags$/);
  }
  assert.throws(() => latestFromRegistryJson({ versions: [] }), /missing dist-tags\.latest/);
  assert.throws(() => registryDistTagsFromJson({ versions: [] }), /not a JSON object with dist-tags/);
  for (const distTags of [undefined, null, [], "tags", {}]) {
    const data = { "dist-tags": distTags };
    assert.throws(() => latestFromRegistryJson(data), /missing dist-tags\.latest/);
    assert.throws(() => registryDistTagsFromJson(data), /missing dist-tags\.latest/);
  }
  for (const latest of [undefined, null, "", 42]) {
    const data = { "dist-tags": { latest, beta: "not-semver" } };
    assert.throws(() => latestFromRegistryJson(data), /missing dist-tags\.latest/);
    assert.throws(() => registryDistTagsFromJson(data), /invalid dist-tags\.latest/);
  }
  const invalidVersion = latestFromRegistryJson({ "dist-tags": { latest: "not-semver", beta: "not-semver" } });
  assert.equal(invalidVersion, "not-semver");
  assert.throws(() => compareVersions("1.0.0", invalidVersion), /Registry latest version is not valid semver/);
  assert.throws(
    () => registryDistTagsFromJson({ "dist-tags": { latest: invalidVersion, beta: "not-semver" } }),
    /invalid dist-tags\.latest/,
  );
  assert.deepEqual(
    registryDistTagsFromJson({ "dist-tags": { latest: "1.0.0", beta: "2.0.0-beta.1" } }),
    { latest: "1.0.0", beta: "2.0.0-beta.1" },
  );
  for (const distTags of [{ latest: "1.0.0" }, { latest: "1.0.0", beta: null }]) {
    assert.equal(latestFromRegistryJson({ "dist-tags": distTags }), "1.0.0");
    assert.deepEqual(registryDistTagsFromJson({ "dist-tags": distTags }), { latest: "1.0.0", beta: null });
  }
  for (const beta of [undefined, "", "not-semver", 42, [], {}]) {
    const data = { "dist-tags": { latest: "1.0.0", beta } };
    assert.equal(latestFromRegistryJson(data), "1.0.0");
    assert.throws(() => registryDistTagsFromJson(data), /invalid dist-tags\.beta/);
  }
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
