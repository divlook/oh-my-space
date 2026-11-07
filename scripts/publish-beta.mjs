import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import getReleasePlan from "@changesets/get-release-plan";
import { selectBetaBaseVersion } from "./lib/beta-release-plan.js";
import { PACKAGE_NAME } from "./lib/package-info.js";
import { betaReleaseEnvironment, temporaryBetaMetadata } from "./verification/beta-metadata.mjs";


const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}
if (args.publish && args.allowDirty) {
  fail("--allow-dirty is only supported for dry-run verification and cannot be combined with --publish.");
}

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
let baseVersion;
try {
  baseVersion = selectBetaBaseVersion(await getReleasePlan(process.cwd()), packageJson.version);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
let activeChild;
let interrupted;

process.once("SIGINT", () => interrupt("SIGINT", 130));
process.once("SIGTERM", () => interrupt("SIGTERM", 143));

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

const metadata = temporaryBetaMetadata(betaVersion);
try {
  await metadata.run(async () => {
    if (args.publish) {
      await run("npm", ["publish", "--tag", "beta"]);
      await run("npm", ["view", PACKAGE_NAME, "dist-tags"]);
    } else {
      await run("npm", ["pack", "--dry-run"]);
      console.log("Dry-run complete. Re-run with --publish to publish this beta version.");
    }
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = interrupted?.code ?? 1;
}

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


async function run(command, args) {
  if (interrupted) throw new Error(`Interrupted by ${interrupted.signal}`);
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
      env: betaReleaseEnvironment(metadata.sourceVersion),
    });
    activeChild = child;
    let spawnError;
    child.on("error", (error) => { spawnError = error; });
    child.on("close", (status, signal) => {
      activeChild = undefined;
      if (spawnError) return reject(spawnError);
      if (status === 0 && !interrupted) return resolve();
      const detail = interrupted ? `signal ${interrupted.signal}` : status === null ? `signal ${signal ?? "unknown"}` : `exit ${status}`;
      reject(new Error(`${command} ${args.join(" ")} failed with ${detail}`));
    });
  });
}

function interrupt(signal, code) {
  interrupted = { signal, code };
  activeChild?.kill(signal);
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function gitStatus() {
  return git("status", "--porcelain");
}


function fail(message) {
  console.error(message);
  process.exit(1);
}

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
