import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { MANIFEST_FILENAME } from "./constants.js";
import { runGit } from "./git.js";
import type { WorkspaceOptions } from "./types.js";

type WorkspaceManifestResolution =
  | { kind: "found"; manifestPath: string; repoRoot: string }
  | { kind: "missing" }
  | { kind: "invalid"; manifestPath: string; reason: string };

/** Locate the authoritative nearest manifest without skipping invalid candidates. */
export function resolveWorkspaceManifest(options: WorkspaceOptions = {}): WorkspaceManifestResolution {
  let current = resolve(options.cwd ?? process.cwd());
  while (true) {
    const manifestPath = join(current, MANIFEST_FILENAME);
    let entry;
    try {
      entry = lstatSync(manifestPath);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOENT") {
        const parent = dirname(current);
        if (parent === current) return { kind: "missing" };
        current = parent;
        continue;
      }
      return {
        kind: "invalid",
        manifestPath,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      if (entry.isFile() || (entry.isSymbolicLink() && statSync(manifestPath).isFile())) {
        return { kind: "found", manifestPath, repoRoot: current };
      }
    } catch {
      return {
        kind: "invalid",
        manifestPath,
        reason: "it is a broken symbolic link or does not resolve to a regular file",
      };
    }
    return {
      kind: "invalid",
      manifestPath,
      reason: "it is not a regular file or a symbolic link to a regular file",
    };
  }
}

export function findWorkspaceRoot(options: WorkspaceOptions = {}): string | null {
  const resolution = resolveWorkspaceManifest(options);
  if (resolution.kind === "found") return resolution.repoRoot;
  if (resolution.kind === "missing") return null;
  throw new Error(
    `Found ${MANIFEST_FILENAME} at ${resolution.manifestPath}, but ${resolution.reason}. ` +
      "Replace that entry with a regular file; OMS will not fall back to an ancestor manifest.",
  );
}

export type WorkspaceGitIdentity =
  | { kind: "match"; gitTopLevel: string }
  | { kind: "mismatch"; gitTopLevel: string }
  | { kind: "no-work-tree" }
  | { kind: "indeterminate"; reason: string };

/** Compare a workspace directory with Git's enclosing top-level using canonical paths. */
export function inspectWorkspaceGitIdentity(workspaceRoot: string): WorkspaceGitIdentity {
  const topLevel = runGit(workspaceRoot, ["rev-parse", "--show-toplevel"], false, {
    ...process.env,
    LANG: "C",
    LC_ALL: "C",
  });
  if (!topLevel.success) {
    const diagnostic = topLevel.stderr.trim();
    if (/not a git repository|not a git work tree/i.test(diagnostic)) return { kind: "no-work-tree" };
    return {
      kind: "indeterminate",
      reason: diagnostic || "Git did not return a repository top-level",
    };
  }

  const gitTopLevel = process.platform === "win32"
    ? topLevel.stdout.replace(/\r?\n$/, "")
    : topLevel.stdout.replace(/\n$/, "");
  if (!gitTopLevel) {
    return { kind: "indeterminate", reason: "Git returned an empty repository top-level" };
  }

  try {
    return realpathSync(workspaceRoot) === realpathSync(gitTopLevel)
      ? { kind: "match", gitTopLevel }
      : { kind: "mismatch", gitTopLevel };
  } catch (error) {
    return {
      kind: "indeterminate",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
