import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import esbuild from "esbuild";

/** Runtime dependencies that must be inlined into the bundle (never externalized). */
const INLINED_DEPS = ["commander", "@clack/prompts", "semver", "yaml"];

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

// Guarantee the bin is executable; do not rely on esbuild's implicit shebang exec bit.
chmodSync("dist/oms.js", 0o755);

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
