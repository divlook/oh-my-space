import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const PACKAGE_JSON = "package.json";
const PACKAGE_LOCK = "package-lock.json";
const PACKAGE_NAME = "oh-my-space";

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

if (args.publish && args.allowDirty) {
  fail("--allow-dirty is only supported for dry-run verification and cannot be combined with --publish.");
}
if (!args.allowDirty) {
  // A run interrupted before restore (e.g. terminal closed during the long prepack
  // test gate) leaves package.json/package-lock.json bumped to a `-beta.sha-` version.
  // The script owns those edits, so recover that specific leftover automatically. This
  // must run before the originals are captured below so restore writes clean content.
  recoverBetaLeftover();
  const dirty = changedFiles();
  if (dirty.length > 0) {
    fail(
      `Working tree must be clean before beta publishing.\n` +
        `Uncommitted changes:\n${dirty.map((file) => `  ${file}`).join("\n")}\n` +
        `Commit or discard them (e.g. git checkout -- <file>), then re-run. ` +
        `Use --allow-dirty only for intentional local verification.`,
    );
  }
}

const packageJsonOriginal = readFileSync(PACKAGE_JSON, "utf8");
const packageLockOriginal = readFileSync(PACKAGE_LOCK, "utf8");
const packageJson = JSON.parse(packageJsonOriginal);
const baseVersion = args.baseVersion ?? packageJson.version;
let shouldRestore = false;

process.once("SIGINT", () => restoreAndExit(130));
process.once("SIGTERM", () => restoreAndExit(143));

if (!isStableSemver(baseVersion)) {
  fail(`--base-version must be a stable semver version, got ${baseVersion}`);
}

const commit = git("rev-parse", "HEAD");
const shortHash = git("rev-parse", "--short=7", "HEAD");
const betaVersion = `${baseVersion}-beta.sha-${shortHash}`;

console.log(`Preparing ${PACKAGE_NAME}@${betaVersion}`);
console.log(`Source commit: ${commit}`);
console.log(`Mode: ${args.publish ? "publish" : "dry-run"}`);

try {
  writePackageVersions(betaVersion);
  shouldRestore = true;
  if (args.publish) {
    run("npm", ["publish", "--tag", "beta"]);
    run("npm", ["view", PACKAGE_NAME, "dist-tags"]);
  } else {
    run("npm", ["pack", "--dry-run"]);
    console.log("Dry-run complete. Re-run with --publish to publish this beta version.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  restorePackageFiles();
}

/** Parses supported CLI flags. */
function parseArgs(argv) {
  const parsed = { publish: false, allowDirty: false, help: false, baseVersion: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--publish") parsed.publish = true;
    else if (arg === "--allow-dirty") parsed.allowDirty = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--base-version") parsed.baseVersion = requireValue(argv, ++i, arg);
    else fail(`Unknown option: ${arg}`);
  }
  return parsed;
}

/** Returns the required option value or exits with a usage error. */
function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) fail(`${option} requires a value`);
  return value;
}

/** Runs a command inheriting stdio and exits on failure. */
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status === 0) return;
  const detail = result.status === null ? `signal ${result.signal ?? "unknown"}` : `exit ${result.status}`;
  throw new Error(`${command} ${args.join(" ")} failed with ${detail}`);
}

/** Writes the temporary beta version to package metadata. */
function writePackageVersions(version) {
  const nextPackageJson = JSON.parse(packageJsonOriginal);
  const nextPackageLock = JSON.parse(packageLockOriginal);
  nextPackageJson.version = version;
  nextPackageLock.version = version;
  if (nextPackageLock.packages?.[""]) nextPackageLock.packages[""].version = version;
  writeFileSync(PACKAGE_JSON, `${JSON.stringify(nextPackageJson, null, 2)}\n`);
  writeFileSync(PACKAGE_LOCK, `${JSON.stringify(nextPackageLock, null, 2)}\n`);
}

/** Restores package metadata after the temporary publish version is no longer needed. */
function restorePackageFiles() {
  if (!shouldRestore) return;
  writeFileSync(PACKAGE_JSON, packageJsonOriginal);
  writeFileSync(PACKAGE_LOCK, packageLockOriginal);
  shouldRestore = false;
}

/** Restores package metadata before exiting from a signal. */
function restoreAndExit(code) {
  restorePackageFiles();
  process.exit(code);
}

/** Runs a git command and returns trimmed stdout. */
function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** Returns the paths of files with uncommitted changes. */
function changedFiles() {
  // Read porcelain output raw: the leading status field is column-aligned, so the
  // path starts at a fixed offset and must not be trimmed away.
  const output = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  return output
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3));
}

/**
 * Restores package.json/package-lock.json when they are the only dirty files and
 * their working-tree version is a `-beta.sha-` prerelease left by an interrupted run.
 */
function recoverBetaLeftover() {
  const dirty = changedFiles();
  if (dirty.length === 0) return;
  const owned = new Set([PACKAGE_JSON, PACKAGE_LOCK]);
  if (!dirty.every((file) => owned.has(file))) return;
  let workingVersion;
  try {
    workingVersion = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")).version;
  } catch {
    return;
  }
  if (!/^\d+\.\d+\.\d+-beta\.sha-/.test(workingVersion)) return;
  git("checkout", "--", ...dirty);
  console.log(`Recovered leftover beta version in ${dirty.join(", ")} from an interrupted run.`);
}

/** Validates stable semver without accepting prerelease/build metadata. */
function isStableSemver(version) {
  return /^\d+\.\d+\.\d+$/.test(version);
}

/** Prints an error and exits. */
function fail(message) {
  console.error(message);
  process.exit(1);
}

/** Prints command usage. */
function printHelp() {
  console.log(`Usage: npm run release:beta -- [--base-version 0.12.0] [--publish] [--allow-dirty]

Creates a temporary prerelease version like 0.12.0-beta.sha-a1b2c3d from the current commit.

Options:
  --base-version <version>  Stable version base for the beta package. Defaults to package.json version.
  --publish                 Publish to npm with the beta dist-tag. Omit for a dry-run pack.
  --allow-dirty             Allow a dirty working tree for dry-run verification only.
  -h, --help                Show this help.
`);
}
