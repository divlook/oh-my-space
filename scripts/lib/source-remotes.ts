import { redactSensitiveUrls, runSub } from "./git.js";
export type RemoteReconciliation = { name: string; ok: true } | { name: string; ok: false; diagnostic: string };

/** Reconcile selected additional remotes; never rewrite the verified origin. */
export function ensureSourceRemotes(repoRoot: string, alias: string, remotes: Record<string, string>, names: string[]): RemoteReconciliation[] {
  const results: RemoteReconciliation[] = [];
  for (const name of names) {
    if (name === "origin") {
      results.push({ name, ok: true });
      continue;
    }
    const url = remotes[name];
    const existing = runSub(repoRoot, alias, ["remote", "get-url", name]);
    if (!existing.success) {
      const added = runSub(repoRoot, alias, ["remote", "add", name, url]);
      results.push(added.success
        ? { name, ok: true }
        : { name, ok: false, diagnostic: redactSensitiveUrls(added.stderr.trim()) });
    } else if (existing.stdout.trim() !== url) {
      const updated = runSub(repoRoot, alias, ["remote", "set-url", name, url]);
      results.push(updated.success
        ? { name, ok: true }
        : { name, ok: false, diagnostic: redactSensitiveUrls(updated.stderr.trim()) });
    } else {
      results.push({ name, ok: true });
    }
  }
  return results;
}
