import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { isFingerprintExcluded } from "./config.mjs";
import { normalizedTestEnvironment } from "./environment.mjs";

function git(cwd, args, env) {
  return execFileSync("git", args, { cwd, env, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
}

function parseTrackedEntries(output) {
  const entries = [];
  for (const record of output.toString("utf8").split("\0")) {
    if (!record) continue;
    const match = /^(\d{6}) ([0-9a-f]{40,64}) (\d)\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error(`Unexpected git ls-files record: ${JSON.stringify(record)}`);
    if (match[3] === "0") entries.push({ path: match[4], indexMode: match[1], indexObject: match[2] });
  }
  return entries;
}

function parsePaths(output) {
  return output.toString("utf8").split("\0").filter(Boolean);
}

function gitObjectId(content, format) {
  const algorithm = format === "sha256" ? "sha256" : "sha1";
  const hash = createHash(algorithm);
  hash.update(`blob ${content.length}\0`);
  hash.update(content);
  return hash.digest("hex");
}

function expectedBeta(cwd, packageVersion, env) {
  const match = /^(\d+\.\d+\.\d+)-beta\.sha-([0-9a-f]{7})$/.exec(packageVersion);
  if (!match) return null;
  const head = git(cwd, ["rev-parse", "--short=7", "HEAD"], env).toString("utf8").trim();
  if (match[2] !== head) return null;
  const sourceVersion = env.OMS_BETA_SOURCE_VERSION;
  const normalizedSourceVersion = sourceVersion == null
    ? null
    : typeof sourceVersion === "string" ? semver.valid(sourceVersion) : null;
  if (sourceVersion != null && normalizedSourceVersion === null) return null;
  const base = normalizedSourceVersion ?? match[1];
  return { base, beta: packageVersion };
}

function normalizeBetaFiles(cwd, contents, env) {
  const packageBuffer = contents.get("package.json");
  const lockBuffer = contents.get("package-lock.json");
  if (!packageBuffer || !lockBuffer) return contents;

  const packageText = packageBuffer.toString("utf8");
  const lockText = lockBuffer.toString("utf8");
  let packageJson;
  let packageLock;
  try {
    packageJson = JSON.parse(packageText);
    packageLock = JSON.parse(lockText);
  } catch {
    return contents;
  }

  const beta = expectedBeta(cwd, packageJson.version, env);
  if (!beta) return contents;
  if (packageLock.version !== beta.beta || packageLock.packages?.[""]?.version !== beta.beta) return contents;

  const encodedBeta = JSON.stringify(beta.beta);
  const encodedBase = JSON.stringify(beta.base);
  const packageOccurrences = packageText.split(encodedBeta).length - 1;
  const lockOccurrences = lockText.split(encodedBeta).length - 1;
  if (packageOccurrences !== 1 || lockOccurrences !== 2) return contents;

  const normalized = new Map(contents);
  normalized.set("package.json", Buffer.from(packageText.replaceAll(encodedBeta, encodedBase)));
  normalized.set("package-lock.json", Buffer.from(lockText.replaceAll(encodedBeta, encodedBase)));
  return normalized;
}

/** Computes a fail-safe repository fingerprint from path, working content, and mode. */
export function computeFingerprint({
  cwd = process.cwd(),
  includeUntracked = true,
  normalizeBeta = true,
  env = normalizedTestEnvironment(),
} = {}) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"], env).toString("utf8").trim();
  const tracked = parseTrackedEntries(git(root, ["ls-files", "--stage", "-z"], env));
  const objectFormat = git(root, ["rev-parse", "--show-object-format"], env).toString("utf8").trim();
  const untracked = includeUntracked
    ? parsePaths(git(root, ["ls-files", "--others", "--exclude-standard", "-z"], env))
    : [];

  const entries = new Map(tracked.map((entry) => [entry.path, entry]));
  for (const path of untracked) {
    if (!entries.has(path)) entries.set(path, { path, indexMode: null, indexObject: null });
  }

  const contents = new Map();
  const modes = new Map();
  const types = new Map();
  for (const entry of entries.values()) {
    if (isFingerprintExcluded(entry.path)) continue;
    const absolute = resolve(root, entry.path);
    if (entry.indexMode === "160000") {
      modes.set(entry.path, entry.indexMode);
      types.set(entry.path, "commit");
      contents.set(entry.path, Buffer.from(entry.indexObject));
      continue;
    }
    try {
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        modes.set(entry.path, "120000");
        types.set(entry.path, "blob");
        contents.set(entry.path, Buffer.from(readlinkSync(absolute)));
      } else if (stat.isFile()) {
        modes.set(entry.path, stat.mode & 0o111 ? "100755" : "100644");
        types.set(entry.path, "blob");
        contents.set(entry.path, readFileSync(absolute));
      } else {
        modes.set(entry.path, entry.indexMode ?? `unsupported:${stat.mode.toString(8)}`);
        types.set(entry.path, "blob");
        contents.set(entry.path, Buffer.from(`<unsupported:${stat.mode.toString(8)}>`));
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        modes.set(entry.path, entry.indexMode ?? "100644");
        types.set(entry.path, "blob");
        contents.set(entry.path, Buffer.from("<deleted>"));
      } else {
        throw error;
      }
    }
  }

  const fingerprintContents = normalizeBeta ? normalizeBetaFiles(root, contents, env) : contents;
  const hash = createHash("sha256");
  for (const path of [...fingerprintContents.keys()].sort()) {
    const content = fingerprintContents.get(path);
    const type = types.get(path) ?? "blob";
    const object = type === "commit" ? content.toString("utf8") : gitObjectId(content, objectFormat);
    hash.update(`${modes.get(path) ?? "100644"} ${type} ${object}\t${path}\n`);
  }
  return { root, fingerprint: hash.digest("hex"), paths: fingerprintContents.size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const includeUntracked = !process.argv.includes("--ci");
  process.stdout.write(`${computeFingerprint({ includeUntracked }).fingerprint}\n`);
}
