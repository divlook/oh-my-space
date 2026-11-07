import { readFileSync, writeFileSync } from "node:fs";

const METADATA_PATHS = ["package.json", "package-lock.json"];

export function betaMetadataContents(packageText, lockText, version) {
  const pkg = JSON.parse(packageText);
  const lock = JSON.parse(lockText);
  pkg.version = version;
  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
  return [`${JSON.stringify(pkg, null, 2)}\n`, `${JSON.stringify(lock, null, 2)}\n`];
}

export function temporaryBetaMetadata(version) {
  const originals = METADATA_PATHS.map((path) => readFileSync(path, "utf8"));
  const temporary = betaMetadataContents(...originals, version);
  return {
    sourceVersion: JSON.parse(originals[0]).version,
    async run(operation) {
      try {
        for (const [index, path] of METADATA_PATHS.entries()) writeFileSync(path, temporary[index]);
        return await operation();
      } finally {
        for (const [index, path] of METADATA_PATHS.entries()) writeFileSync(path, originals[index]);
      }
    },
  };
}

// Reuse accepts only the exact temporary release transform, not arbitrary version edits.
export function stableMetadataContents(packageText, lockText, { beta, base }) {
  const pkg = JSON.parse(packageText);
  const lock = JSON.parse(lockText);
  if (pkg.version !== beta || lock.version !== beta || lock.packages?.[""]?.version !== beta) return null;
  const encodedBeta = JSON.stringify(beta);
  if (packageText.split(encodedBeta).length - 1 !== 1 || lockText.split(encodedBeta).length - 1 !== 2) return null;
  const stable = [packageText.replaceAll(encodedBeta, JSON.stringify(base)), lockText.replaceAll(encodedBeta, JSON.stringify(base))];
  return stable;
}

export function betaSourceVersion(env) {
  return env.OMS_BETA_SOURCE_VERSION;
}

export function betaReleaseEnvironment(sourceVersion) {
  return { ...process.env, OMS_BETA_SOURCE_VERSION: sourceVersion };
}
