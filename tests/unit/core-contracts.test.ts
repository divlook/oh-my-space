import assert from "node:assert/strict";
import test from "node:test";
import { parseManifest, validateSources } from "../../scripts/lib/manifest.js";
import { inferAliasFromCwd } from "../../scripts/lib/source-workspace.js";

test("manifest validation normalizes valid repositories and rejects structural ambiguity", () => {
  assert.deepEqual(
    validateSources({ repos: [{ alias: "api", remotes: { origin: "https://example.com/api.git", backup: "ssh://backup/api.git" }, branch: "main" }] }),
    [{ alias: "api", remotes: { origin: "https://example.com/api.git", backup: "ssh://backup/api.git" }, branch: "main" }],
  );
  const invalid: Array<[unknown, RegExp]> = [
    [null, /root must be a mapping/],
    [{ repos: [] }, /at least one item/],
    [{ repos: [{ alias: "api", url: "https:\/\/example.com" }] }, /url is no longer supported/],
    [{ repos: [{ alias: "api", remotes: { upstream: "https:\/\/example.com" } }] }, /include an "origin"/],
    [{ repos: [{ alias: "api", remotes: { origin: "x" } }, { alias: "api", remotes: { origin: "y" } }] }, /duplicate alias/],
  ];
  for (const [value, message] of invalid) assert.throws(() => validateSources(value), message);
});

test("normal manifest parsing rejects legacy registration settings and points to migration", () => {
  const text = "repos:\n  - alias: api\n    remotes:\n      origin: https://example.com/api.git\n";
  const repos = [{ alias: "api", remotes: { origin: "https://example.com/api.git" }, branch: undefined }];
  assert.deepEqual(parseManifest(text).repos, repos);
  for (const value of ["true", "false"]) {
    assert.throws(() => parseManifest(`autoCommitRegistration: ${value}\n${text}`), /legacy setting.*oms migrate --dry-run/);
  }
  assert.throws(() => parseManifest(`autoCommit: true\n${text}`), /legacy setting.*OMS 2\.x.*migrating/);
});

test("status path inference respects alias path segment boundaries", () => {
  const repos = [{ alias: "api", remotes: { origin: "x" } }, { alias: "api-extra", remotes: { origin: "y" } }];
  assert.equal(inferAliasFromCwd("/workspace", repos, "/workspace/oms/api/src"), "api");
  assert.equal(inferAliasFromCwd("/workspace", repos, "/workspace/oms/api-extra"), "api-extra");
  assert.equal(inferAliasFromCwd("/workspace", repos.slice(0, 1), "/workspace/oms/api-extra"), null);
});
