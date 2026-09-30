import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveWorkspaceManifest } from "../../scripts/lib/git.js";
import { loadRepos, validateSources } from "../../scripts/lib/manifest.js";

const manifest = "repos:\n  - alias: api\n    remotes:\n      origin: https://example.com/api.git\n";

test("workspace manifest resolution prefers nearest files, accepts file symlinks, and fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "oms-manifest-resolution-"));
  try {
    const parent = join(root, "parent");
    const child = join(parent, "child");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(parent, "oms.yaml"), manifest);

    assert.deepEqual(resolveWorkspaceManifest({ cwd: child }), {
      kind: "found",
      manifestPath: join(parent, "oms.yaml"),
      repoRoot: parent,
    });

    const childManifest = join(child, "oms.yaml");
    writeFileSync(childManifest, manifest.replace("api.git", "web.git"));
    const nearest = loadRepos({ cwd: child });
    assert.equal(nearest?.repoRoot, child);
    assert.equal(nearest?.repos[0]?.remotes.origin, "https://example.com/web.git");

    unlinkSync(childManifest);
    const target = join(root, "linked-manifest.yaml");
    writeFileSync(target, manifest);
    symlinkSync(target, childManifest);
    const linked = loadRepos({ cwd: child });
    assert.equal(linked?.repoRoot, child);
    assert.equal(linked?.repos[0]?.alias, "api");

    const candidates = [
      (path: string) => mkdirSync(path),
      (path: string) => symlinkSync(join(root, "missing.yaml"), path),
      (path: string) => {
        const directory = join(root, "manifest-directory");
        mkdirSync(directory);
        symlinkSync(directory, path);
      },
    ];
    for (const createCandidate of candidates) {
      rmSync(childManifest, { recursive: true, force: true });
      createCandidate(childManifest);
      assert.equal(resolveWorkspaceManifest({ cwd: child }).kind, "invalid");
      const before = readdirSync(child).sort();
      assert.equal(loadRepos({ cwd: child }), null);
      assert.deepEqual(readdirSync(child).sort(), before);
      rmSync(childManifest, { recursive: true, force: true });
    }

    writeFileSync(childManifest, "repos: []\n");
    assert.equal(loadRepos({ cwd: child }), null);
    assert.equal(existsSync(join(child, "oms")), false);
    writeFileSync(childManifest, "repos:\n  - alias: invalid.alias\n    remotes:\n      origin: https://example.com/api.git\n");
    assert.throws(() => validateSources({ repos: [{ alias: "invalid.alias", remotes: { origin: "https://example.com/api.git" } }] }), /alias/);
    const before = readdirSync(child).sort();
    assert.equal(loadRepos({ cwd: child }), null);
    assert.deepEqual(readdirSync(child).sort(), before);
    assert.equal(existsSync(join(child, "oms")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
