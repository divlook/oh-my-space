import { aliasDir, productionGitRunner, redactSensitiveUrls, resolveOriginHead, runGit, submodulePath } from "./git.js";
import { loadRepos } from "./manifest.js";
import { resolveBaselines } from "./branch-baseline.js";
import { inspectCleanSourceSafety } from "./source-safety.js";
import type { GitResult, Repo } from "./types.js";

type Ref = Readonly<{ ref: string; oid: string; symbolic: string }>;
type Branch = Ref & Readonly<{ name: string; reasons: readonly string[] }>;
type Context = Readonly<{ declaration: string; registration: string; recorded: string }>;
export type BranchCleanPlan = Readonly<{ alias: string; base: Ref; context: Context; branches: readonly Branch[]; limitedHistory: boolean }>;
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

function captureContext(root: string, alias: string): Context {
  const loaded = loadRepos({ cwd: root });
  const repo = loaded?.repos.find((entry) => entry.alias === alias);
  if (!repo || loaded?.repoRoot !== root) throw new Error("Selected repository declaration cannot be inspected or no longer exists.");
  const declaration = JSON.stringify([repo.alias, repo.branch ?? null, Object.entries(repo.remotes).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]);
  const path = submodulePath(alias);
  const tree = checked(root, ["ls-tree", "-z", "HEAD", "--", path], "Cannot inspect root HEAD recorded source gitlink");
  const match = tree.stdout.match(/^160000 commit ([0-9a-f]{40,64})\t([^\0]+)\0$/);
  if (!match || match[2] !== path) throw new Error(`Root HEAD does not record a source gitlink for ${alias}; run "oms sync ${alias}" first.`);
  const index = checked(root, ["ls-files", "--stage", "-z", "--", path], "Cannot inspect selected registration index");
  if (!new RegExp(`^160000 [0-9a-f]{40,64} 0\\t${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\0$`).test(index.stdout)) {
    throw new Error(`Selected registration is inconsistent; run "oms sync ${alias}" first.`);
  }
  const keyPrefix = `submodule.${path}.`;
  const snapshots: string[] = [];
  for (const args of [["--blob", "HEAD:.gitmodules"], ["--blob", ":.gitmodules"], ["--file", ".gitmodules"], ["--local"]]) {
    const result = checked(root, ["config", ...args, "--null", "--list"], "Cannot inspect selected registration configuration");
    const entries = result.stdout.split("\0").filter((entry) => entry.startsWith(keyPrefix)).sort();
    if (args[0] !== "--local" && !entries.includes(`submodule.${path}.path\n${path}`)) throw new Error("Selected registration path changed or is inconsistent; run oms sync first.");
    snapshots.push(JSON.stringify(entries));
  }
  return Object.freeze({ declaration, registration: JSON.stringify(snapshots), recorded: match[1] });
}

function inspectSafety(root: string, repo: Repo, context: Context): SourceSafety {
  const dir = aliasDir(root, repo.alias);
  const refusal = inspectCleanSourceSafety(dir, repo.alias, context.recorded);
  if (refusal) throw new Error(refusal);
  const baseline = resolveBaselines(root, repo);
  if (!baseline.ok) throw new Error(baseline.reason);
  const protectedBranches = new Map<string, string[]>();
  for (const item of baseline.protectedReasons) {
    const reasons = protectedBranches.get(item.branch) ?? [];
    reasons.push(item.reason);
    protectedBranches.set(item.branch, reasons);
  }
  const current = runGit(dir, ["symbolic-ref", "--quiet", "HEAD"]);
  if ((!current.success && current.exitCode !== 1) || current.stderr.trim() || (current.success && !/^refs\/heads\/.+$/.test(current.stdout.trim()))) throw new Error("Cannot inspect current source branch.");
  if (current.success) {
    const name = current.stdout.trim().replace(/^refs\/heads\//, "");
    protectedBranches.set(name, [...(protectedBranches.get(name) ?? []), "current branch"]);
  }
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

function ancestry(dir: string, tip: string, base: string, shallow: boolean): string | null {
  const result = runGit(dir, ["merge-base", "--is-ancestor", tip, base]);
  if (result.exitCode === 0 && !result.stderr.trim()) return null;
  if (result.exitCode === 1 && !result.stderr.trim()) return shallow ? "ancestry not proven with limited shallow history; deepen or repair history explicitly, then rerun" : "not merged into the selected base";
  throw new Error(`Cannot inspect ancestry: ${redactSensitiveUrls(result.stderr.trim()) || "Git inspection failed"}`);
}

export function planBranchClean(root: string, repo: Repo, baseArg: string | undefined): BranchCleanPlan {
  const dir = aliasDir(root, repo.alias);
  const context = captureContext(root, repo.alias);
  const safety = inspectSafety(root, repo, context);
  const refs = inventory(dir);
  const defaultName = repo.branch ?? resolveOriginHead(dir);
  // Baseline resolution above must succeed even when an explicit comparison is supplied.
  const requested = baseArg ?? (defaultName ? `refs/heads/${defaultName}` : "");
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
  return Object.freeze({ alias: repo.alias, context, base, branches: Object.freeze(branches), limitedHistory });
}

export function executeBranchClean(root: string, repo: Repo, plan: BranchCleanPlan): BranchCleanOutcome[] {
  const dir = aliasDir(root, repo.alias);
  const candidates = plan.branches.filter((branch) => !branch.reasons.length);
  const outcomes: BranchCleanOutcome[] = [];
  let stop: string | undefined;
  for (const branch of candidates) {
    if (stop) { outcomes.push({ branch, kind: "not run", reason: stop }); continue; }
    let refs: readonly Ref[];
    let safety: SourceSafety;
    try {
      const context = captureContext(root, repo.alias);
      if (context.declaration !== plan.context.declaration || context.registration !== plan.context.registration || context.recorded !== plan.context.recorded) throw new Error("Selected declaration, registration information, or root HEAD recorded source commit changed after confirmation.");
      safety = inspectSafety(root, repo, context);
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
    const deletion = productionGitRunner(dir, ["update-ref", "--no-deref", "--stdin"], Buffer.from(transaction));
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
