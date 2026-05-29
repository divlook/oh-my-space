import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

let commit = null;
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  // not a git repo (e.g. building from a published tarball) — fall back at runtime
}

mkdirSync("dist", { recursive: true });
writeFileSync("dist/build-info.json", JSON.stringify({ commit }) + "\n");
