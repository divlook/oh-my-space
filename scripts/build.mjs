import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import esbuild from "esbuild";

/**
 * Top-level runtime dependencies that must be inlined into the bundle (never
 * externalized). Used only by the self-containment assertion as a sanity check;
 * the third-party notices are derived from the full bundle graph, not this list.
 */
const INLINED_DEPS = ["commander", "@clack/prompts", "semver", "yaml"];

/** Candidate license-file basenames to look for inside an installed dependency (matched case-insensitively). */
const LICENSE_FILENAMES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING"];

const result = await esbuild.build({
  entryPoints: ["scripts/oms.ts"],
  outfile: "dist/oms.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: false,
  keepNames: true,
  sourcemap: false,
  legalComments: "eof",
  metafile: true,
  // Inlining CommonJS deps into an ESM bundle breaks their internal require()
  // calls ("Dynamic require ... is not supported"); back them with createRequire.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});

assertSelfContained(result.metafile);

// Build metadata: written as a sibling of dist/oms.js and read at runtime.
let commit = null;
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  // not a git repo (e.g. building from a published tarball) — fall back at runtime
}
mkdirSync("dist", { recursive: true });
writeFileSync("dist/build-info.json", JSON.stringify({ commit }) + "\n");

// The inlined deps are vendored into the bundle; MIT/ISC require their notices to
// ship with it. esbuild's legalComments only collects inline source comments, which
// these packages don't carry (they ship separate LICENSE files), so emit a sibling
// notices file instead. It ships via the existing "dist/" entry in package.json files.
writeFileSync("dist/THIRD-PARTY-NOTICES.txt", buildThirdPartyNotices(result.metafile));

// Guarantee the bin is executable; do not rely on esbuild's implicit shebang exec bit.
chmodSync("dist/oms.js", 0o755);

/**
 * Builds the third-party attribution text reproducing every bundled package's
 * license and copyright notice, as required by their MIT/ISC terms. The package
 * set is derived from the esbuild bundle graph so transitive deps are covered too.
 * @param {import("esbuild").Metafile} metafile - esbuild metafile for the build
 * @returns {string} the full notices document
 */
function buildThirdPartyNotices(metafile) {
  const deps = collectBundledPackages(metafile);
  if (deps.length === 0) {
    console.error("No bundled third-party packages found in metafile; cannot build notices.");
    process.exit(1);
  }
  const sections = deps.map((dep) => {
    const pkg = JSON.parse(readFileSync(`node_modules/${dep}/package.json`, "utf8"));
    const license = readLicenseText(dep);
    const heading = `${pkg.name}@${pkg.version} (${normalizeLicense(pkg.license)})`;
    const rule = "=".repeat(80);
    return `${rule}\n${heading}\n${rule}\n\n${license}`;
  });
  const header =
    "oh-my-space bundles the following third-party packages into dist/oms.js.\n" +
    "Their licenses and copyright notices are reproduced below.\n";
  return [header, ...sections].join("\n") + "\n";
}

/**
 * Derives the sorted set of npm package names esbuild vendored into the bundle
 * from the metafile inputs (own source files have no node_modules segment).
 * @param {import("esbuild").Metafile} metafile - esbuild metafile for the build
 * @returns {string[]} sorted unique package names (scoped names kept intact)
 */
function collectBundledPackages(metafile) {
  const names = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const marker = input.lastIndexOf("node_modules/");
    if (marker === -1) continue;
    const rest = input.slice(marker + "node_modules/".length).split("/");
    const name = rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
    if (name) names.add(name);
  }
  return [...names].sort();
}

/**
 * Normalizes the npm package.json `license` field (string, `{ type }` object, or
 * array of either) into a single display label.
 * @param {unknown} license - the raw package.json license field
 * @returns {string} a human-readable license label
 */
function normalizeLicense(license) {
  if (typeof license === "string") return license;
  if (Array.isArray(license)) {
    const labels = license.map(normalizeLicense).filter(Boolean);
    if (labels.length > 0) return labels.join(", ");
  } else if (license && typeof license === "object" && typeof license.type === "string") {
    return license.type;
  }
  return "see notice below";
}

/**
 * Reads a dependency's license file text, trying common filenames case-insensitively.
 * @param {string} dep - dependency package name (its node_modules folder)
 * @returns {string} the license file contents, trimmed
 */
function readLicenseText(dep) {
  const wanted = new Set(LICENSE_FILENAMES.map((name) => name.toLowerCase()));
  for (const entry of readdirSync(`node_modules/${dep}`)) {
    if (wanted.has(entry.toLowerCase())) {
      return readFileSync(`node_modules/${dep}/${entry}`, "utf8").trim();
    }
  }
  console.error(`Could not find a license file for bundled dep "${dep}"`);
  process.exit(1);
}

/**
 * Fails the build unless the bundle is self-contained: only Node builtins may be
 * external, and every inlined dependency must appear among the bundle inputs.
 * @param {import("esbuild").Metafile} metafile - esbuild metafile for the build
 */
function assertSelfContained(metafile) {
  const output = metafile.outputs["dist/oms.js"];
  const badExternals = (output?.imports ?? [])
    .filter((imp) => imp.external)
    .filter((imp) => !isBuiltin(imp.path));
  if (badExternals.length > 0) {
    const names = badExternals.map((imp) => imp.path).join(", ");
    console.error(`Bundle is not self-contained: non-builtin externals remain: ${names}`);
    process.exit(1);
  }

  const inputs = Object.keys(metafile.inputs);
  const missing = INLINED_DEPS.filter(
    (dep) => !inputs.some((path) => path.includes(`node_modules/${dep}/`)),
  );
  if (missing.length > 0) {
    console.error(`Bundle is missing expected inlined deps: ${missing.join(", ")}`);
    process.exit(1);
  }
}
