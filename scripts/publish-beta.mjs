import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import getReleasePlan from "@changesets/get-release-plan";
import { selectBetaBaseVersion } from "./lib/beta-release-plan.js";
import { PACKAGE_NAME } from "./lib/package-info.js";

const PACKAGE_JSON = "package.json";
const PACKAGE_LOCK = "package-lock.json";

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}
if (args.publish && args.allowDirty) {
  fail("--allow-dirty is only supported for dry-run verification and cannot be combined with --publish.");
}

const packageJsonOriginal = readFileSync(PACKAGE_JSON, "utf8");
const packageLockOriginal = readFileSync(PACKAGE_LOCK, "utf8");
const packageJson = JSON.parse(packageJsonOriginal);
let baseVersion;
try {
  baseVersion = selectBetaBaseVersion(await getReleasePlan(process.cwd()), packageJson.version);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
let shouldRestore = false;
let activeChild;

process.once("SIGINT", () => restoreAndExit("SIGINT", 130));
process.once("SIGTERM", () => restoreAndExit("SIGTERM", 143));

console.log(`Changesets stable target: ${baseVersion}`);
if (!args.allowDirty && gitStatus().length > 0) {
  fail("Working tree must be clean before beta publishing. Use --allow-dirty only for intentional local verification.");
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
    await run("npm", ["publish", "--tag", "beta"]);
    await run("npm", ["view", PACKAGE_NAME, "dist-tags"]);
  } else {
    await run("npm", ["pack", "--dry-run"]);
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
  const parsed = { publish: false, allowDirty: false, help: false };
  for (const arg of argv) {
    if (arg === "--publish") parsed.publish = true;
    else if (arg === "--allow-dirty") parsed.allowDirty = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else fail(`Unknown option: ${arg}`);
  }
  return parsed;
}


/** Runs a command inheriting stdio and exits on failure. */
async function run(command, args) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, OMS_BETA_SOURCE_VERSION: packageJson.version },
  });
  activeChild = child;
  try {
    const [status, signal] = await once(child, "exit");
    if (status === 0) return;
    const detail = status === null ? `signal ${signal ?? "unknown"}` : `exit ${status}`;
    throw new Error(`${command} ${args.join(" ")} failed with ${detail}`);
  } finally {
    activeChild = undefined;
  }
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
function restoreAndExit(signal, code) {
  restorePackageFiles();
  activeChild?.kill(signal);
  process.exit(code);
}

/** Runs a git command and returns trimmed stdout. */
function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** Returns porcelain status output. */
function gitStatus() {
  return git("status", "--porcelain");
}


/** Prints an error and exits. */
function fail(message) {
  console.error(message);
  process.exit(1);
}

/** Prints command usage. */
function printHelp() {
  console.log(`Usage: npm run release:beta -- [--publish] [--allow-dirty]

Derives the next stable version from pending Changesets and creates a temporary prerelease
like 1.0.0-beta.sha-a1b2c3d from the current commit.

Options:
  --publish      Publish to npm with the beta dist-tag. Omit for a dry-run pack.
  --allow-dirty  Allow a dirty working tree for dry-run verification only.
  -h, --help     Show this help.
`);
}
