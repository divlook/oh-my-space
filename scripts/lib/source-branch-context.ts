import { runGit } from "./git.js";
import { inspectIndependentCheckoutIdentity, type ReadySourceCheckout, type SourceWorkspace } from "./source-checkout.js";
import { loadForSources } from "./source-workspace.js";
import type { Repo } from "./types.js";

export function sourceBaseline(dir: string, repo: Repo, originHeadReliable = true): string | null {
  if (repo.branch) return repo.branch;
  if (!originHeadReliable) return null;
  const head = runGit(dir, ["symbolic-ref", "--no-recurse", "refs/remotes/origin/HEAD"]);
  const prefix = "refs/remotes/origin/";
  const ref = head.stdout.replace(/\r?\n$/, "");
  if (!head.success || head.stderr || !ref.startsWith(prefix) || ref === `${prefix}HEAD`) return null;
  const tip = runGit(dir, ["for-each-ref", "--format=%(refname)%00%(objecttype)%00%(symref)", ref]);
  return tip.success && !tip.stderr && tip.stdout.split("\n").includes(`${ref}\0commit\0`) ? ref.slice(prefix.length) : null;
}

export type SourceBranchContext = Readonly<{ declaration: string; identity: string }>;

/** Capture selection and physical identity, not anything recorded by root Git. */
export function captureSourceBranchContext(workspace: SourceWorkspace, alias: string, checkout: ReadySourceCheckout): SourceBranchContext {
  const loaded = loadForSources({ cwd: workspace.root }, workspace.git);
  const repo = loaded?.repos.find((entry) => entry.alias === alias);
  if (!repo || loaded?.repoRoot !== workspace.root) throw new Error("Selected source declaration cannot be inspected or no longer exists.");
  const { path, gitDir, origin, device, inode, gitDevice, gitInode } = inspectIndependentCheckoutIdentity(loaded.workspace, repo, checkout);
  const remotes = Object.entries(repo.remotes).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return { declaration: JSON.stringify([repo.alias, repo.branch ?? null, remotes]), identity: JSON.stringify([path, gitDir, origin, device, inode, gitDevice, gitInode]) };
}
