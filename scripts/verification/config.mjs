export const VERIFICATION_RECORD_PATH = ".oms-verification.json";
export const VERIFICATION_SCHEMA_VERSION = 1;

const EXCLUDED_ROOT_FILES = new Set([
  ".ci-verified",
  "AGENTS.md",
  "CHANGELOG.md",
  "CLAUDE.md",
  "README.md",
  VERIFICATION_RECORD_PATH,
]);

const EXCLUDED_PREFIXES = [
  ".claude/",
  ".test-dist/",
  "dist/",
  "docs/",
  "node_modules/",
  "openspec/",
];

/** Returns whether a repository-relative path cannot affect canonical tests. */
export function isFingerprintExcluded(path) {
  return EXCLUDED_ROOT_FILES.has(path) || EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix));
}
