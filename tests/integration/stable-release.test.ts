import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test, { after } from "node:test";
import { normalizedTestEnvironment } from "../../scripts/verification/environment.mjs";

const project = resolve(".");
const roots: string[] = [];
const realNpm = (process.env.PATH ?? "").split(delimiter).map((directory) => join(directory, "npm")).find((path) => existsSync(path));
const version = "1.2.3";
const tag = `v${version}`;
const notes = "### Patch Changes\n\n- Preserve **stable** release metadata.\n";

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// This executable owns only the external process boundary. Git refs are real
// objects in the fixture's bare remote; release bodies survive separate runs.
const fakeApi = `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const root = process.cwd();
const directory = path.join(root, '.fixture');
const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
const binary = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const record = (value) => fs.appendFileSync(path.join(directory, 'calls.jsonl'), JSON.stringify(value) + '\\n');
const fail = (status, message = 'fixture failure') => { console.error('gh: ' + message + ' (HTTP ' + status + ')'); process.exit(1); };
const git = (...args) => cp.execFileSync('git', ['--git-dir', config.remote, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const output = (value) => console.log(JSON.stringify(value));
if (binary === 'npm') {
  record({ binary, args });
  if (args.join(' ') !== 'view oh-my-space@' + config.requestVersion + ' name version gitHead --json --registry https://registry.npmjs.org') throw new Error('Unexpected npm request: ' + args.join(' '));
  if (config.npmFail) { console.error('Registry unavailable'); process.exit(1); }
  output(config.metadata);
} else if (binary === 'changeset') {
  record({ binary, args });
  if (args.join(' ') !== 'publish') throw new Error('Unexpected publisher request');
  console.log(config.publisherOutput || 'Created git tags.');
  process.exit(config.publisherExit || 0);
} else if (binary === 'gh') {
  if (args.shift() !== 'api') throw new Error('Expected gh api');
  let hostname, method = 'GET', endpoint, input;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--hostname') hostname = args.shift();
    else if (arg === '--method' || arg === '-X') method = args.shift();
    else if (arg === '--input') input = args.shift();
    else if (!arg.startsWith('-') && !endpoint) endpoint = arg.replace(/^\\//, '');
    else throw new Error('Unexpected gh argument: ' + arg);
  }
  if (hostname !== 'github.com' || !endpoint) throw new Error('Unexpected API target');
  const body = input === '-' ? JSON.parse(fs.readFileSync(0, 'utf8')) : null;
  record({ binary, method, endpoint, body });
  if (config.failRead === endpoint && method === 'GET') fail(config.readStatus || 503);
  const repo = 'repos/divlook/oh-my-space';
  if (endpoint === repo && method === 'GET') output({ full_name: config.repoName || 'divlook/oh-my-space' });
  else if (endpoint.startsWith(repo + '/git/ref/tags/') && method === 'GET') {
    const ref = 'refs/tags/' + endpoint.slice((repo + '/git/ref/tags/').length);
    let sha;
    try { sha = git('rev-parse', '--verify', ref); } catch { fail(404, 'Not Found'); }
    output({ ref, object: { type: git('cat-file', '-t', sha), sha } });
  } else if (endpoint.startsWith(repo + '/git/tags/') && method === 'GET') {
    const sha = endpoint.slice((repo + '/git/tags/').length);
    const object = git('cat-file', '-p', sha);
    output({ sha, object: { sha: object.match(/^object (.+)$/m)[1], type: object.match(/^type (.+)$/m)[1] } });
  } else if (endpoint === repo + '/git/refs' && method === 'POST') {
    if (!body.ref.startsWith('refs/tags/')) throw new Error('Unexpected ref write');
    git('update-ref', body.ref, body.sha, '0000000000000000000000000000000000000000');
    output({ ref: body.ref, object: { type: 'commit', sha: body.sha } });
  } else if (endpoint.startsWith(repo + '/releases/tags/') && method === 'GET') {
    const releases = JSON.parse(fs.readFileSync(path.join(directory, 'releases.json'), 'utf8'));
    const release = releases[endpoint.slice((repo + '/releases/tags/').length)];
    if (!release) fail(404, 'Not Found');
    output(release);
  } else if (endpoint === repo + '/releases' && method === 'POST') {
    if (config.failCreateRelease) fail(503);
    const releases = JSON.parse(fs.readFileSync(path.join(directory, 'releases.json'), 'utf8'));
    if (releases[body.tag_name]) fail(422, 'Already exists');
    git('rev-parse', '--verify', 'refs/tags/' + body.tag_name + '^{commit}');
    const release = { ...body, id: Object.keys(releases).length + 1, html_url: 'https://github.com/divlook/oh-my-space/releases/tag/' + body.tag_name };
    releases[body.tag_name] = release;
    fs.writeFileSync(path.join(directory, 'releases.json'), JSON.stringify(releases));
    output(release);
  } else throw new Error('Unexpected API request: ' + method + ' ' + endpoint);
} else throw new Error('Unexpected fake executable: ' + binary);
`;

interface FixtureOptions {
  packageName?: string;
  packageVersion?: string;
  changelog?: string | null;
}

function fixture(options: FixtureOptions = {}) {
  const temporary = mkdtempSync(join(tmpdir(), "oms-stable-release-"));
  roots.push(temporary);
  const root = join(temporary, "work");
  const remote = join(temporary, "remote.git");
  const bin = join(root, ".fake-bin");
  const state = join(root, ".fixture");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}\n');
  mkdirSync(state);
  mkdirSync(join(root, "scripts", "lib"), { recursive: true });
  for (const binary of ["npm", "gh", "changeset"]) {
    writeFileSync(join(bin, binary), fakeApi);
    chmodSync(join(bin, binary), 0o755);
  }
  writeFileSync(join(root, "scripts", "finalize-stable-release.mjs"), readFileSync(join(project, "scripts", "finalize-stable-release.mjs")));
  writeFileSync(join(root, "scripts", "lib", "package-info.js"), readFileSync(join(project, "scripts", "lib", "package-info.js")));
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  symlinkSync(join(project, "node_modules", "semver"), join(root, "node_modules", "semver"), "dir");
  // npm prepends node_modules/.bin: never expose the real publisher there.
  symlinkSync(join(bin, "changeset"), join(root, "node_modules", ".bin", "changeset"));
  const release = JSON.parse(readFileSync(join(project, "package.json"), "utf8")).scripts.release;
  const packageJson = { name: options.packageName ?? "oh-my-space", version: options.packageVersion ?? version, type: "module", scripts: { release } };
  writeFileSync(join(root, "package.json"), `${JSON.stringify(packageJson)}\n`);
  if (options.changelog !== null) writeFileSync(join(root, "CHANGELOG.md"), options.changelog ?? `# oh-my-space\n\n## ${version}\n\n${notes}\n## 1.2.2\n\nOlder release notes must not leak.\n`);
  writeFileSync(join(root, ".gitignore"), ".fake-bin/\n.fixture/\nnode_modules/\n");
  const env = normalizedTestEnvironment({ PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` });
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["init", "--bare", remote], { env, stdio: "ignore" });
  git("init", "-b", "main");
  git("add", ".");
  git("commit", "-m", "Published stable version");
  const commit = git("rev-parse", "HEAD");
  git("remote", "add", "origin", remote);
  git("push", "-u", "origin", "main");
  const config: Record<string, unknown> = { remote, requestVersion: version, metadata: { name: "oh-my-space", version, gitHead: commit } };
  const configure = (changes: Record<string, unknown>) => {
    Object.assign(config, changes);
    writeFileSync(join(state, "config.json"), JSON.stringify(config));
  };
  configure({});
  writeFileSync(join(state, "releases.json"), "{}");
  writeFileSync(join(state, "calls.jsonl"), "");
  const calls = () => readFileSync(join(state, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const writes = () => calls().filter((call) => call.binary === "gh" && call.method !== "GET");
  const releases = () => JSON.parse(readFileSync(join(state, "releases.json"), "utf8"));
  const setRelease = (body: Record<string, unknown>) => writeFileSync(join(state, "releases.json"), JSON.stringify({ [tag]: { id: 1, tag_name: tag, draft: false, prerelease: false, body: "Maintainer-curated notes.", ...body } }));
  const remoteTag = () => execFileSync("git", ["--git-dir", remote, "rev-parse", "--verify", `refs/tags/${tag}^{commit}`], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const run = (args: string[] = []) => spawnSync(process.execPath, [join(root, "scripts", "finalize-stable-release.mjs"), ...args], { cwd: root, env, encoding: "utf8" });
  const recover = () => run(["--version", version, "--commit", commit]);
  const laterCommit = () => {
    packageJson.version = "1.2.4";
    writeFileSync(join(root, "package.json"), JSON.stringify(packageJson));
    writeFileSync(join(root, "CHANGELOG.md"), "# oh-my-space\n\n## 1.2.4\n\nUnpublished checkout notes.\n");
    git("add", "package.json", "CHANGELOG.md");
    git("commit", "-m", "Later main commit");
    git("push", "origin", "main");
    return git("rev-parse", "HEAD");
  };
  return { root, env, remote, commit, git, configure, calls, writes, releases, setRelease, remoteTag, run, recover, laterCommit };
}

interface ApiCall {
  binary: string;
  method?: string;
  endpoint: string;
}

interface Release {
  tag_name: string;
  target_commitish: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  make_latest: string;
}

interface Fixture {
  root: string;
  env: NodeJS.ProcessEnv;
  remote: string;
  commit: string;
  git(...args: string[]): string;
  configure(changes: Record<string, unknown>): void;
  calls(): ApiCall[];
  writes(): ApiCall[];
  releases(): Record<string, Release>;
  setRelease(body: Record<string, unknown>): void;
  remoteTag(): string;
  run(args?: string[]): SpawnSyncReturns<string>;
  recover(): SpawnSyncReturns<string>;
  laterCommit(): string;
}

function success(result: SpawnSyncReturns<string>) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

function failure(result: SpawnSyncReturns<string>) {
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /phase|preflight|identity|metadata|release|tag|publication|registry|version|changelog|commit/i);
  assert.match(result.stderr, /node scripts\/finalize-stable-release\.mjs/);
}

function complete(f: Fixture) {
  assert.equal(f.remoteTag(), f.commit);
  const release = f.releases()[tag];
  assert.ok(release);
  assert.equal(release.tag_name, tag);
  assert.equal(release.target_commitish, f.commit);
  assert.equal(release.name, tag);
  assert.equal(release.body.trim(), notes.trim());
  assert.equal(release.draft, false);
  assert.equal(release.prerelease, false);
}

test("stable finalization derives current and historical publication identity from npm and committed notes", () => {
  const current = fixture();
  success(current.run());
  complete(current);

  const historical = fixture();
  const later = historical.laterCommit();
  assert.notEqual(later, historical.commit);
  success(historical.recover());
  complete(historical);
  assert.doesNotMatch(historical.releases()[tag].body, /Unpublished|Older/);

  const currentVersionAtLaterHead = fixture();
  currentVersionAtLaterHead.laterCommit();
  const packagePath = join(currentVersionAtLaterHead.root, "package.json");
  const metadata = JSON.parse(readFileSync(packagePath, "utf8"));
  metadata.version = version;
  writeFileSync(packagePath, JSON.stringify(metadata));
  success(currentVersionAtLaterHead.run());
  complete(currentVersionAtLaterHead);

  const fallback = fixture();
  fallback.git("update-ref", "-d", "refs/remotes/origin/main");
  success(fallback.run());
  complete(fallback);
});

test("stable finalization refuses unverifiable identities and missing release evidence before writes", () => {
  const cases: { name: string; options?: FixtureOptions; change?: (f: Fixture) => void; args?: (f: Fixture) => string[] }[] = [
    { name: "registry failure", change: (f) => f.configure({ npmFail: true }) },
    { name: "missing npm metadata", change: (f) => f.configure({ metadata: {} }) },
    { name: "missing gitHead", change: (f) => f.configure({ metadata: { name: "oh-my-space", version } }) },
    { name: "wrong registry package", change: (f) => f.configure({ metadata: { name: "other", version, gitHead: f.commit } }) },
    { name: "wrong registry version", change: (f) => f.configure({ metadata: { name: "oh-my-space", version: "1.2.2", gitHead: f.commit } }) },
    { name: "missing local commit", change: (f) => f.configure({ metadata: { name: "oh-my-space", version, gitHead: "a".repeat(40) } }) },
    { name: "explicit commit mismatch", args: () => ["--version", version, "--commit", "b".repeat(40)] },
    { name: "incomplete explicit identity", args: () => ["--version", version] },
    { name: "empty explicit identity", args: () => ["--version", "", "--commit", ""] },
    { name: "wrong committed package", options: { packageName: "other" }, args: (f) => ["--version", version, "--commit", f.commit] },
    { name: "wrong committed version", options: { packageVersion: "1.2.2" }, args: (f) => ["--version", version, "--commit", f.commit] },
    { name: "missing changelog", options: { changelog: null } },
    { name: "missing version notes", options: { changelog: "# Changelog\n\n## 1.2.2\n\nOld notes.\n" } },
    { name: "empty version notes", options: { changelog: `# Changelog\n\n## ${version}\n\n## 1.2.2\n\nOld notes.\n` } },
    { name: "prerelease", options: { packageVersion: "1.2.3-beta.1" }, change: (f) => f.configure({ requestVersion: "1.2.3-beta.1", metadata: { name: "oh-my-space", version: "1.2.3-beta.1", gitHead: f.commit } }) },
    { name: "wrong GitHub repository", change: (f) => f.configure({ repoName: "other/repository" }) },
    { name: "not on remote main", change: (f) => { const later = f.laterCommit(); f.git("update-ref", "refs/remotes/origin/main", f.commit); f.configure({ metadata: { name: "oh-my-space", version, gitHead: later } }); } },
  ];
  for (const scenario of cases) {
    const f = fixture(scenario.options);
    scenario.change?.(f);
    failure(f.run(scenario.args?.(f)));
    assert.deepEqual(f.writes(), [], scenario.name);
    assert.deepEqual(f.releases(), {}, scenario.name);
    assert.throws(() => f.remoteTag(), scenario.name);
  }
});

test("stable finalization completes annotated tag-only state and preserves matching release prose on rerun", () => {
  const f = fixture();
  f.git("tag", "-a", tag, f.commit, "-m", "Existing annotated stable tag");
  f.git("push", "origin", `refs/tags/${tag}`);
  const originalTagObject = f.git("rev-parse", tag);
  success(f.recover());
  complete(f);
  assert.deepEqual(f.writes().map((call) => call.endpoint), ["repos/divlook/oh-my-space/releases"]);
  assert.equal(execFileSync("git", ["--git-dir", f.remote, "rev-parse", `refs/tags/${tag}`], { env: f.env, encoding: "utf8" }).trim(), originalTagObject);
  f.setRelease({ body: "Maintainer-curated notes remain exactly unchanged.\n" });
  const before = f.releases();
  const count = f.writes().length;
  success(f.recover());
  assert.deepEqual(f.releases(), before);
  assert.equal(f.writes().length, count);
  assert.equal(f.remoteTag(), f.commit);
});

test("stable finalization leaves conflicting metadata and non-404 read failures untouched", () => {
  for (const kind of ["wrong-tag", "draft", "prerelease", "tag-read", "release-read", "repository-read"] as const) {
    const f = fixture();
    if (kind === "wrong-tag") {
      const later = f.laterCommit();
      f.git("tag", tag, later);
      f.git("push", "origin", `refs/tags/${tag}`);
    } else if (kind === "draft" || kind === "prerelease") {
      // Deliberately no tag: an incompatible Release must prevent tag creation.
      f.setRelease({ [kind]: true });
    } else {
      const suffix = kind === "tag-read" ? `/git/ref/tags/${tag}` : kind === "release-read" ? `/releases/tags/${tag}` : "";
      f.configure({ failRead: `repos/divlook/oh-my-space${suffix}`, readStatus: 503 });
    }
    const before = f.releases();
    const tagBefore = kind === "wrong-tag" ? f.remoteTag() : null;
    failure(f.recover());
    assert.deepEqual(f.writes(), [], kind);
    assert.deepEqual(f.releases(), before, kind);
    if (tagBefore) assert.equal(f.remoteTag(), tagBefore);
    else assert.throws(() => f.remoteTag());
  }
});

test("stable finalization retains a valid tag after release creation failure and resumes without duplicate writes", () => {
  const f = fixture();
  f.configure({ failCreateRelease: true });
  const result = f.recover();
  failure(result);
  assert.match(result.stderr, new RegExp(`--version ${version.replaceAll(".", "\\.")} --commit ${f.commit}`));
  assert.equal(f.remoteTag(), f.commit);
  assert.deepEqual(f.releases(), {});
  f.configure({ failCreateRelease: false });
  success(f.recover());
  complete(f);
  assert.equal(f.writes().filter((call) => call.endpoint.endsWith("/git/refs")).length, 1);
  const writes = f.writes().length;
  success(f.recover());
  assert.equal(f.writes().length, writes);
  complete(f);
});

test("npm release completes metadata independently of publisher messages and propagates process failures", () => {
  assert.ok(realNpm, "A real npm executable is required for the release entrypoint contract");
  for (const scenario of ["new", "already-published", "publisher-failure", "finalizer-failure"] as const) {
    const f = fixture();
    const output = scenario === "already-published" ? "No unpublished projects to publish" : "Created git tags.";
    f.configure({ publisherOutput: output, publisherExit: scenario === "publisher-failure" ? 42 : 0, failCreateRelease: scenario === "finalizer-failure" });
    const result = spawnSync(realNpm, ["run", "release"], { cwd: f.root, env: f.env, encoding: "utf8" });
    if (scenario === "publisher-failure") {
      assert.notEqual(result.status, 0);
      assert.equal(f.calls().filter((call) => call.binary !== "changeset").length, 0);
      assert.deepEqual(f.releases(), {});
      assert.throws(() => f.remoteTag());
    } else if (scenario === "finalizer-failure") {
      failure(result);
      assert.equal(f.remoteTag(), f.commit);
      assert.deepEqual(f.releases(), {});
    } else {
      success(result);
      complete(f);
    }
  }
});
