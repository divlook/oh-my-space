import semver from "semver";
import { isScalar, parseDocument } from "yaml";

/** Standard human-readable compatibility sentence derived from an OMS semver range. */
export function skillCompatibilitySentence(omsVersion) {
  return `Requires oh-my-space ${omsVersion}.`;
}
function parseFrontmatter(raw) {
  const frontmatter = raw.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/);
  return frontmatter ? parseDocument(frontmatter[1] ?? "") : null;
}


/** Parses independently verifiable version fields from skill frontmatter. */
export function parseSkillMetadata(raw) {
  let document;
  try {
    document = parseFrontmatter(raw);
    if (!document || document.errors.length > 0) return { version: null, omsVersion: null };
  } catch {
    return { version: null, omsVersion: null };
  }

  const version = document.getIn(["metadata", "version"]);
  const omsVersion = document.getIn(["metadata", "oh-my-space-version"]);
  return {
    version: typeof version === "string" && version === version.trim() && semver.valid(version) === version
      ? version
      : null,
    omsVersion: typeof omsVersion === "string" && omsVersion !== "" && omsVersion === omsVersion.trim() &&
      semver.validRange(omsVersion) !== null
      ? omsVersion
      : null,
  };
}

/** Validates the complete published-skill compatibility contract and returns its build reference. */
export function validatePublishedSkillMetadata(raw, skillPath) {
  let document;
  try {
    document = parseFrontmatter(raw);
  } catch (error) {
    throw new Error(`${skillPath}: could not parse frontmatter: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!document) throw new Error(`${skillPath}: frontmatter must be a YAML block`);
  if (document.errors.length > 0) {
    throw new Error(`${skillPath}: frontmatter is invalid YAML: ${document.errors[0].message}`);
  }

  const versionNode = document.getIn(["metadata", "version"], true);
  const version = document.getIn(["metadata", "version"]);
  if (!isScalar(versionNode) || (versionNode.type !== "QUOTE_DOUBLE" && versionNode.type !== "QUOTE_SINGLE") ||
      typeof version !== "string" || version !== version.trim() || semver.valid(version) !== version) {
    throw new Error(`${skillPath}: metadata.version must be a quoted semver string in canonical form, got ${JSON.stringify(version)}`);
  }

  const omsVersionNode = document.getIn(["metadata", "oh-my-space-version"], true);
  const omsVersion = document.getIn(["metadata", "oh-my-space-version"]);
  if (!isScalar(omsVersionNode) || (omsVersionNode.type !== "QUOTE_DOUBLE" && omsVersionNode.type !== "QUOTE_SINGLE") ||
      typeof omsVersion !== "string" || omsVersion === "" || omsVersion !== omsVersion.trim() ||
      semver.validRange(omsVersion) === null) {
    throw new Error(`${skillPath}: metadata.oh-my-space-version must be a quoted semver range, got ${JSON.stringify(omsVersion)}`);
  }

  const compatibility = document.get("compatibility");
  const expected = skillCompatibilitySentence(omsVersion);
  if (compatibility !== expected) {
    throw new Error(`${skillPath}: compatibility must exactly equal ${JSON.stringify(expected)}, got ${JSON.stringify(compatibility)}`);
  }

  return { version, omsVersion };
}
