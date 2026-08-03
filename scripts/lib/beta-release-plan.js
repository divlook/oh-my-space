import semver from "semver";
import { PACKAGE_NAME } from "./package-info.js";

/** Selects the single forward stable target for oh-my-space from a Changesets release plan. */
export function selectBetaBaseVersion(releasePlan, currentVersion) {
  const releases = releasePlan?.releases;
  if (!Array.isArray(releases)) {
    throw new Error("Changesets did not return a valid release plan.");
  }
  const matches = releases.filter((release) => release?.name === PACKAGE_NAME);
  if (matches.length === 0) {
    throw new Error(`A pending Changeset release for ${PACKAGE_NAME} is required before publishing beta.`);
  }
  if (matches.length !== 1) {
    throw new Error(`Changesets returned ${matches.length} releases for ${PACKAGE_NAME}; expected exactly one.`);
  }

  const newVersion = matches[0]?.newVersion;
  const parsedNewVersion = typeof newVersion === "string" ? semver.parse(newVersion) : null;
  if (!parsedNewVersion || parsedNewVersion.prerelease.length > 0 || parsedNewVersion.build.length > 0) {
    throw new Error(`Changesets returned a non-stable ${PACKAGE_NAME} version: ${String(newVersion)}`);
  }
  if (!semver.valid(currentVersion)) {
    throw new Error(`package.json has an invalid version: ${currentVersion}`);
  }
  if (!semver.gt(newVersion, currentVersion)) {
    throw new Error(`Changesets target ${newVersion} must be greater than package.json version ${currentVersion}.`);
  }
  return newVersion;
}
