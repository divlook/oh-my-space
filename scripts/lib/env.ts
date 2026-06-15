import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCS_REPO_BLOB_BASE } from "./constants.js";

/** Absolute path of this module's file; the single source for import.meta.url across the CLI. */
export const moduleFilePath = fileURLToPath(import.meta.url);

export const packageRoot = resolve(dirname(moduleFilePath), "..");
export const useColor = process.stdout.isTTY;
export const dim = (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);

export function isTestMode(): boolean {
  return process.env.OMS_TEST_MODE === "1";
}

export function testEnv(name: string): string | undefined {
  return isTestMode() ? process.env[name] : undefined;
}

export function runtimePlatform(): NodeJS.Platform {
  const mocked = testEnv("OMS_TEST_PLATFORM");
  return mocked === "win32" ? "win32" : process.platform;
}

export function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - s.length));
}

export function uniqueAliases(aliases: string[]): string[] {
  const seen = new Set<string>();
  return aliases.filter((alias) => {
    if (seen.has(alias)) return false;
    seen.add(alias);
    return true;
  });
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function readPackageVersion(): string {
  const pkg = readJson<{ version?: string }>(join(packageRoot, "package.json"));
  return pkg?.version ?? "0.0.0";
}

/** The commit baked in at build time, or null when unavailable (dev/no-git build). */
export function readBuildCommit(): string | null {
  const info = readJson<{ commit?: string | null }>(
    join(dirname(moduleFilePath), "build-info.json"),
  );
  return info?.commit ?? null;
}

/** Clickable GitHub permalink for a repo doc, pinned to the build commit; falls back to the version tag. */
export function docUrl(relPath: string): string {
  const ref = readBuildCommit() ?? `v${readPackageVersion()}`;
  return `${DOCS_REPO_BLOB_BASE}/${ref}/${relPath}`;
}
