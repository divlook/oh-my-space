import { cancel, log } from "@clack/prompts";
import { aliasDir, productionGitRunner, redactSensitiveUrls, resolveOriginHead, runGit, submoduleInitialized, submodulePath } from "./git.js";
import { loadForSubmodules, loadRepos } from "./manifest.js";
import { prepareAlias } from "./alias-preparation.js";
import { resolveBaselines } from "./branch-baseline.js";
import { canPrompt, guardedConfirm, guardedSelect, isCancel } from "./prompt-adapter.js";
import { inspectCleanSourceSafety } from "./source-safety.js";
import { refuseInsideManagedTree } from "./tree-ops.js";
import type { GitResult, Repo } from "./types.js";

type Ref = Readonly<{ ref: string; oid: string; symbolic: string }>;
type Branch = Ref & Readonly<{ name: string; reasons: readonly string[] }>;
type Context = Readonly<{ declaration: string; registration: string; recorded: string }>;
type Plan = Readonly<{ alias: string; base: Ref; context: Context; branches: readonly Branch[] }>;
type Outcome = { branch: Branch; kind: "deleted" | "already absent" | "preserved" | "failed" | "not run"; reason?: string; configFailed?: boolean };
type SourceSafety = { protected: Map<string, string[]>; shallow: boolean };

/** Dynamic recovery arguments must remain literal in a POSIX shell. */
function shq(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }

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
  const keyPattern = `^submodule\\.${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`;
  const snapshots: string[] = [];
  for (const args of [["--blob", "HEAD:.gitmodules"], ["--blob", ":.gitmodules"], ["--file", ".gitmodules"], ["--local"]]) {
    checked(root, ["config", ...args, "--list"], "Cannot inspect selected registration configuration");
    const result = runGit(root, ["config", ...args, "--null", "--get-regexp", keyPattern]);
    const absentLocal = args[0] === "--local" && result.exitCode === 1 && !result.stderr.trim();
    if ((!result.success && !absentLocal) || result.stderr.trim()) throw new Error("Selected registration information could not be inspected; repair registration with oms sync, then retry.");
    const entries = result.stdout.split("\0").filter(Boolean).sort();
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

function makePlan(root: string, repo: Repo, baseArg: string | undefined): Plan {
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
  const branches = refs.filter((entry) => entry.ref.startsWith("refs/heads/")).map((entry): Branch => {
    const name = entry.ref.slice("refs/heads/".length);
    const reasons = [...(safety.protected.get(name) ?? [])];
    if (entry.ref === base.ref) reasons.push("selected comparison base");
    if (entry.symbolic) reasons.push("symbolic local branch ref");
    if (!reasons.length) {
      const reason = ancestry(dir, entry.oid, base.oid, safety.shallow);
      if (reason) reasons.push(reason);
    }
    return Object.freeze({ ...entry, name, reasons: Object.freeze(reasons) });
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return Object.freeze({ alias: repo.alias, context, base, branches: Object.freeze(branches) });
}

function execute(root: string, repo: Repo, plan: Plan): Outcome[] {
  const dir = aliasDir(root, repo.alias);
  const candidates = plan.branches.filter((branch) => !branch.reasons.length);
  const outcomes: Outcome[] = [];
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
      // The next candidate repeats every shared check; a moved base therefore stops the rest.
      continue;
    }
    const config = runGit(dir, ["config", "--local", "--remove-section", `branch.${branch.name}`], false, { ...process.env, LC_ALL: "C", LANG: "C" });
    const missing = config.exitCode === 128 && /^fatal: no such section: /m.test(config.stderr);
    outcomes.push({ branch, kind: "deleted", configFailed: !config.success && !missing, ...(!config.success && !missing ? { reason: `branch configuration cleanup failed: ${redactSensitiveUrls(config.stderr.trim()) || "Git refused cleanup"}` } : {}) });
  }
  return outcomes;
}

/** Confirm and clean merged local refs in exactly one declared source; no force or network refresh. */
export async function runBranchClean(aliasArg: string | undefined, options: { base?: string }): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;
  if (refuseInsideManagedTree(repoRoot)) return 1;
  let alias = aliasArg;
  if (alias === undefined) {
    if (!canPrompt()) { log.error('Pass an alias and rerun interactively: "oms branch clean <alias>".'); return 1; }
    const initialized = repos.filter((repo) => submoduleInitialized(repoRoot, repo.alias));
    if (!initialized.length) { log.error('No initialized declared source repositories. Run "oms sync" first.'); return 1; }
    const selected = await guardedSelect<string>({ message: "Select a source repository to clean merged local branches", options: initialized.map((repo) => ({ value: repo.alias, label: repo.alias })) });
    if (isCancel(selected)) { cancel("Cancelled."); return 1; }
    alias = selected;
  }
  const repo = repos.find((entry) => entry.alias === alias);
  if (!repo) { log.error(`Unknown alias ${JSON.stringify(alias)}. Use "oms sync --list" to see declared aliases.`); return 1; }
  const wasInitialized = submoduleInitialized(repoRoot, repo.alias);
  const preparation = await prepareAlias(repoRoot, repo, { command: "branch clean", topologyOffer: false });
  if (!preparation.ok) return preparation.code;
  const effects = wasInitialized ? "Preparation: the source was already initialized; no initialization was needed." : "Preparation initialized the registered source; fetched data, baseline branch creation or attachment, and tracking configuration remain even if cleanup is declined.";
  let plan: Plan;
  try { plan = makePlan(repoRoot, repo, options.base); }
  catch (error) { log.error(error instanceof Error ? error.message : String(error)); log.info(effects); return 1; }
  log.info(`Cleanup ${plan.alias}: comparison base ${plan.base.ref} ${plan.base.oid} (local/cached refs; not refreshed).`);
  log.info(effects);
  log.warn("Do not mutate source branches, worktrees, or configuration through other Git or IDE operations from confirmation waiting through completion. Commit-value transactions do not atomically protect ref type, generation, occupancy, metadata, or configuration; same-name recreation and movement away and back to the same OID are not distinguished.");
  for (const branch of plan.branches) log.info(`${branch.reasons.length ? "Excluded" : "Candidate"}: ${branch.name} ${branch.oid}${branch.reasons.length ? ` — ${branch.reasons.join(", ")}` : ""}`);
  const candidates = plan.branches.filter((branch) => !branch.reasons.length);
  if (!candidates.length) { log.info("No eligible merged local branches to clean."); return 0; }
  const rerun = `oms branch clean ${shq(repo.alias)}${options.base !== undefined ? ` --base ${shq(options.base)}` : ""}`;
  if (!canPrompt()) { log.error(`No branches deleted. Rerun in an interactive terminal: ${rerun}`); return 1; }
  const confirmed = await guardedConfirm({ message: `Delete these ${candidates.length} merged local branches in ${repo.alias}?`, initialValue: false });
  if (isCancel(confirmed) || !confirmed) { cancel("Cleanup declined or cancelled; no branches deleted."); log.info(effects); return 1; }
  const outcomes = execute(repoRoot, repo, plan);
  for (const outcome of outcomes) {
    log.info(`${outcome.kind}: ${outcome.branch.name} ${outcome.branch.oid}${outcome.reason ? ` — ${outcome.reason}` : ""}`);
    if (outcome.kind === "deleted") {
      log.info(`Recreate while the commit remains available: git -C ${shq(aliasDir(repoRoot, repo.alias))} branch -- ${shq(outcome.branch.name)} ${shq(outcome.branch.oid)}`);
      if (outcome.configFailed) log.warn(`Ref deletion completed; configuration cleanup is incomplete. Repair: git -C ${shq(aliasDir(repoRoot, repo.alias))} config --local --remove-section ${shq(`branch.${outcome.branch.name}`)}`);
    }
  }
  const incomplete = outcomes.some((outcome) => !["deleted", "already absent"].includes(outcome.kind) || outcome.configFailed);
  log.info(`Cleanup summary: ${["deleted", "already absent", "preserved", "failed", "not run"].map((kind) => `${kind} ${outcomes.filter((outcome) => outcome.kind === kind).length}`).join(", ")}.`);
  if (incomplete) log.warn(`Completed deletions remain; no rollback or force retry. Resolve the reported issue, then rerun: ${rerun}`);
  return incomplete ? 2 : 0;
}
