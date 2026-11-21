import { redactSensitiveUrls, runGit } from "./git.js";
import { requireAttachedSource } from "./source-safety.js";
import type { GitResult, Repo } from "./types.js";
import { captureSourceBranchContext, sourceBaseline, type SourceBranchContext } from "./source-branch-context.js";
import type { ReadySourceCheckout, SourceWorkspace } from "./source-checkout.js";

type Ref = Readonly<{ ref: string; oid: string; symbolic: string }>;
type Branch = Ref & Readonly<{ name: string; reasons: readonly string[] }>;
export type SourceBranchCleanPlan = Readonly<{
  alias: string;
  base: Ref;
  checkout: ReadySourceCheckout;
  context: SourceBranchContext;
  defaultBaseline: string | null;
  branches: readonly Branch[];
  limitedHistory: boolean;
}>;
export type BranchCleanOutcome = { branch: Branch; kind: "deleted" | "already absent" | "preserved" | "failed" | "not run"; reason?: string; configFailed?: boolean };
type SourceSafety = { protected: Map<string, string[]>; shallow: boolean };

function checked(dir: string, args: string[], label: string): GitResult {
  const result = runGit(dir, args);
  if (!result.success || result.stderr.trim()) throw new Error(`${label}: ${redactSensitiveUrls(result.stderr.trim()) || "Git inspection failed"}`);
  return result;
}

function inventory(dir: string): readonly Ref[] {
  const result = checked(dir, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)%00%(objecttype)", "refs/heads/", "refs/remotes/"], "Cannot inspect branch refs");
  return Object.freeze(result.stdout.split("\n").filter(Boolean).map((line) => {
    const fields = line.split("\0");
    if (fields.length !== 4 || !/^refs\/(heads|remotes)\/.+/.test(fields[0]) || !/^[0-9a-f]{40,64}$/.test(fields[1]) || fields[3] !== "commit") {
      throw new Error("Cannot inspect branch refs: invalid or non-commit branch entry.");
    }
    return Object.freeze({ ref: fields[0], oid: fields[1], symbolic: fields[2] });
  }));
}

function inspectWorktrees(dir: string, current: string, protectedBranches: Map<string, string[]>): SourceSafety {
  protectedBranches.set(current, [...(protectedBranches.get(current) ?? []), "current branch"]);
  const worktrees = checked(dir, ["worktree", "list", "--porcelain", "-z"], "Cannot inspect all source worktrees");
  const records = worktrees.stdout.split("\0\0").filter(Boolean);
  if (!records.length) throw new Error("Cannot inspect all source worktrees: empty inventory.");
  for (const record of records) {
    const fields = record.split("\0").filter(Boolean);
    const states = fields.filter((field) => field.startsWith("branch ") || field === "detached" || field === "bare");
    if (!fields[0]?.startsWith("worktree ") || !fields[0].slice(9) || states.length !== 1 || (!fields.includes("bare") && !fields.some((field) => /^HEAD [0-9a-f]{40,64}$/.test(field)))) throw new Error("Cannot inspect all source worktrees: malformed inventory.");
    for (const field of fields) {
      if (!field.startsWith("branch ")) continue;
      if (!field.startsWith("branch refs/heads/")) throw new Error("Cannot inspect all source worktrees: invalid branch.");
      const name = field.slice("branch refs/heads/".length);
      protectedBranches.set(name, [...(protectedBranches.get(name) ?? []), `checked out in worktree ${fields[0].slice(9)}`]);
    }
  }
  const shallow = checked(dir, ["rev-parse", "--is-shallow-repository"], "Cannot inspect shallow history").stdout.trim();
  if (shallow !== "true" && shallow !== "false") throw new Error("Cannot inspect shallow history: invalid result.");
  return { protected: protectedBranches, shallow: shallow === "true" };
}

function inspectIndependentSafety(dir: string, repo: Repo): { baseline: string; safety: SourceSafety } {
  const source = requireAttachedSource(dir, repo.alias);
  if ("reason" in source) throw new Error(source.reason);
  const baseline = sourceBaseline(dir, repo);
  if (!baseline) throw new Error(`${repo.alias}: origin/HEAD could not be resolved. Declare "branch" in oms.yaml or repair it with git remote set-head origin -a inside oms/${repo.alias}.`);
  return { baseline, safety: inspectWorktrees(dir, source.branch, new Map([[baseline, [repo.branch ? "manifest baseline" : "origin default baseline"]]])) };
}

function ancestry(dir: string, tip: string, base: string, shallow: boolean): string | null {
  const result = runGit(dir, ["merge-base", "--is-ancestor", tip, base]);
  if (result.exitCode === 0 && !result.stderr.trim()) return null;
  if (result.exitCode === 1 && !result.stderr.trim()) return shallow ? "ancestry not proven with limited shallow history; deepen or repair history explicitly, then rerun" : "not merged into the selected base";
  throw new Error(`Cannot inspect ancestry: ${redactSensitiveUrls(result.stderr.trim()) || "Git inspection failed"}`);
}

export function planSourceBranchClean(workspace: SourceWorkspace, repo: Repo, checkout: ReadySourceCheckout, baseArg: string | undefined): SourceBranchCleanPlan {
  const dir = checkout.path;
  const context = captureSourceBranchContext(workspace, repo.alias, checkout);
  const { baseline, safety } = inspectIndependentSafety(dir, repo);
  const refs = inventory(dir);
  // Baseline resolution above must succeed even when an explicit comparison is supplied.
  const requested = baseArg ?? `refs/heads/${baseline}`;
  const matches = refs.filter((entry) => requested.startsWith("refs/") ? entry.ref === requested : entry.ref === `refs/heads/${requested}` || entry.ref === `refs/remotes/${requested}`);
  if (matches.length !== 1 || matches[0].symbolic) throw new Error(`Comparison base ${JSON.stringify(requested)} is missing, ambiguous, or symbolic. Supply an existing direct local or remote-tracking branch with --base; no refs were refreshed.`);
  const base = matches[0];
  let limitedHistory = false;
  const branches = refs.filter((entry) => entry.ref.startsWith("refs/heads/")).map((entry): Branch => {
    const name = entry.ref.slice("refs/heads/".length);
    const reasons = [...(safety.protected.get(name) ?? [])];
    if (entry.ref === base.ref) reasons.push("selected comparison base");
    if (entry.symbolic) reasons.push("symbolic local branch ref");
    if (!reasons.length) {
      const reason = ancestry(dir, entry.oid, base.oid, safety.shallow);
      if (reason) {
        reasons.push(reason);
        if (safety.shallow) limitedHistory = true;
      }
    }
    return Object.freeze({ ...entry, name, reasons: Object.freeze(reasons) });
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return Object.freeze({ alias: repo.alias, checkout, context, base, branches: Object.freeze(branches), limitedHistory, defaultBaseline: baseArg === undefined ? baseline : null });
}

export function executeSourceBranchClean(workspace: SourceWorkspace, repo: Repo, plan: SourceBranchCleanPlan): BranchCleanOutcome[] {
  const dir = plan.checkout.path;
  function revalidate(): SourceSafety {
    const context = captureSourceBranchContext(workspace, repo.alias, plan.checkout);
    if (context.declaration !== plan.context.declaration || context.identity !== plan.context.identity) throw new Error("Selected declaration or checkout identity changed after confirmation.");
    const { baseline, safety } = inspectIndependentSafety(dir, repo);
    if (plan.defaultBaseline !== null && baseline !== plan.defaultBaseline) throw new Error("The baseline selecting the displayed comparison base changed after confirmation.");
    return safety;
  }

  const git = workspace.git;
  const candidates = plan.branches.filter((branch) => !branch.reasons.length);
  const outcomes: BranchCleanOutcome[] = [];
  let stop: string | undefined;
  for (const branch of candidates) {
    if (stop) { outcomes.push({ branch, kind: "not run", reason: stop }); continue; }
    let refs: readonly Ref[];
    let safety: SourceSafety;
    try {
      safety = revalidate();
      refs = inventory(dir);
      const base = refs.find((entry) => entry.ref === plan.base.ref);
      if (!base || base.symbolic || base.oid !== plan.base.oid) throw new Error("Displayed comparison base changed or is no longer a direct branch ref.");
    } catch (error) {
      stop = error instanceof Error ? error.message : String(error);
      outcomes.push({ branch, kind: "not run", reason: stop }); continue;
    }
    const candidate = refs.find((entry) => entry.ref === branch.ref);
    if (!candidate) { outcomes.push({ branch, kind: "already absent" }); continue; }
    const reasons = [...(safety.protected.get(branch.name) ?? [])];
    if (candidate.symbolic) reasons.push("candidate became a symbolic ref");
    if (candidate.oid !== branch.oid) reasons.push("candidate tip changed after confirmation");
    if (!reasons.length) {
      try {
        const reason = ancestry(dir, candidate.oid, plan.base.oid, safety.shallow);
        if (reason) reasons.push(reason);
      } catch (error) {
        stop = error instanceof Error ? error.message : String(error);
        outcomes.push({ branch, kind: "not run", reason: stop }); continue;
      }
    }
    if (reasons.length) { outcomes.push({ branch, kind: "preserved", reason: reasons.join(", ") }); continue; }
    const transaction = `start\nverify ${plan.base.ref} ${plan.base.oid}\ndelete ${branch.ref} ${branch.oid}\nprepare\ncommit\n`;
    const deletion = git(dir, ["update-ref", "--no-deref", "--stdin"], Buffer.from(transaction));
    if (!deletion.success) {
      outcomes.push({ branch, kind: "failed", reason: `expected-commit ref transaction failed: ${redactSensitiveUrls(deletion.stderr.trim()) || "Git refused deletion"}` });
      continue;
    }
    const config = runGit(dir, ["config", "--local", "--remove-section", `branch.${branch.name}`], false, { ...process.env, LC_ALL: "C", LANG: "C" });
    const missing = config.exitCode === 128 && /^fatal: no such section: /m.test(config.stderr);
    outcomes.push({ branch, kind: "deleted", configFailed: !config.success && !missing, ...(!config.success && !missing ? { reason: `branch configuration cleanup failed: ${redactSensitiveUrls(config.stderr.trim()) || "Git refused cleanup"}` } : {}) });
  }
  return outcomes;
}
