import { runGit } from "./git.js";

/** Root index paths staged relative to HEAD, read NUL-delimited so unusual path names stay intact. */
export function stagedRootPaths(repoRoot: string): string[] {
  const r = runGit(repoRoot, ["diff", "--cached", "--name-only", "-z"]);
  if (!r.success) return [];
  return r.stdout.split("\0").filter((p) => p.length > 0);
}
