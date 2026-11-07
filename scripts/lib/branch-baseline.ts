import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { aliasDir, productionGitRunner, resolveOriginHead, runGit, submodulePath } from "./git.js";
import type { Repo } from "./types.js";

export type ProtectedReason = { branch: string; reason: string };

type BaselineResolution =
  | { ok: true; protectedReasons: ProtectedReason[]; driftWarning: string | null }
  | { ok: false; reason: string };

type BaselineReport = {
  state: "known" | "incomplete" | "unknown";
  baselines: ProtectedReason[];
  unmatched: string[];
  warnings: string[];
};

type GitmodulesSource = {
  label: string;
  rawContent: string;
};

function readGitConfigValues(entries: readonly string[], key: string): string[] {
  const prefix = `${key}\n`;
  const values: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    for (const line of entry.slice(prefix.length).split("\n")) {
      const value = line.trim();
      if (value) values.push(value);
    }
  }
  return values;
}

function countSectionHeaders(content: string, path: string): number {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^\\s*\\[submodule "${escaped}"\\]\\s*$`);
  return content.split("\n").filter((line) => header.test(line)).length;
}

function collectSources(repoRoot: string): { sources: GitmodulesSource[]; errors: string[] } {
  const sources: GitmodulesSource[] = [];
  const errors: string[] = [];

  const worktreePath = join(repoRoot, ".gitmodules");
  if (existsSync(worktreePath)) {
    try {
      sources.push({
        label: "working tree .gitmodules",
        rawContent: readFileSync(worktreePath, "utf8"),
      });
    } catch {
      errors.push("the working tree .gitmodules could not be read (permission or I/O error)");
    }
  }

  const staged = runGit(repoRoot, ["ls-files", "--stage", "--", ".gitmodules"]);
  if (!staged.success) {
    errors.push("the index .gitmodules sources could not be listed; retry once Git is idle");
  }
  const stages = new Set<string>();
  for (const line of staged.success ? staged.stdout.split("\n") : []) {
    const m = line.match(/^\d+ [0-9a-f]+ ([0-3])\t/);
    if (m) stages.add(m[1]);
  }
  const indexStages = stages.has("0") ? ["0"] : ["1", "2", "3"].filter((s) => stages.has(s));
  for (const stage of indexStages) {
    const show = runGit(repoRoot, ["show", `:${stage}:.gitmodules`]);
    if (!show.success) {
      errors.push(`index .gitmodules (stage ${stage}) was listed but could not be read; retry once Git is idle`);
      continue;
    }
    sources.push({
      label: stage === "0" ? "index .gitmodules" : `index .gitmodules (stage ${stage})`,
      rawContent: show.stdout,
    });
  }

  const headEntry = runGit(repoRoot, ["ls-tree", "HEAD", "--", ".gitmodules"]);
  if (!headEntry.success) {
    errors.push("HEAD .gitmodules presence could not be inspected; retry once Git is idle");
  } else if (headEntry.stdout.trim().length > 0) {
    const show = runGit(repoRoot, ["show", "HEAD:.gitmodules"]);
    if (!show.success) {
      errors.push("HEAD .gitmodules exists but could not be read; retry once Git is idle");
    } else {
      sources.push({
        label: "HEAD .gitmodules",
        rawContent: show.stdout,
      });
    }
  }

  return { sources, errors };
}

type BaselineProvenance =
  | { kind: "manifest" }
  | { kind: "origin-default" }
  | { kind: "gitmodules"; source: string };
type BaselineObservation = { branch: string; provenance: BaselineProvenance };
type SourceObservation =
  | { ok: true; source: string; branch: string | null }
  | { ok: false; warning: string; refusal: string };

function observeSource(repoRoot: string, source: GitmodulesSource, path: string): SourceObservation {
  const problem = (message: string): SourceObservation => ({
    ok: false,
    warning: `${source.label} ${message}`,
    refusal: `${source.label} ${message}; repair it, then retry`,
  });
  if (countSectionHeaders(source.rawContent, path) > 1) return problem(`has duplicate "${path}" submodule sections`);
  const parsed = productionGitRunner(repoRoot, ["config", "--file", "-", "--null", "--list"], Buffer.from(source.rawContent));
  if (!parsed.success) return problem("has invalid Git config syntax");
  const entries = parsed.stdout.split("\0");
  const paths = readGitConfigValues(entries, `submodule.${path}.path`);
  if (paths.length > 1) return problem(`has multiple "path" values for "${path}"`);
  const branches = readGitConfigValues(entries, `submodule.${path}.branch`);
  if (branches.length > 1) return problem(`has multiple "branch" values for "${path}"`);
  return { ok: true, source: source.label, branch: branches[0] ?? null };
}

function observeMetadata(repoRoot: string, alias: string): { errors: string[]; sources: SourceObservation[] } {
  const collected = collectSources(repoRoot);
  return { errors: collected.errors, sources: collected.sources.map((source) => observeSource(repoRoot, source, submodulePath(alias))) };
}

function firstBaselines(observations: BaselineObservation[]): BaselineObservation[] {
  const first = new Map<string, BaselineObservation>();
  for (const observation of observations) if (!first.has(observation.branch)) first.set(observation.branch, observation);
  return [...first.values()];
}

function renderReason(provenance: BaselineProvenance, reporting: boolean): string {
  if (provenance.kind === "manifest") return "oms.yaml baseline";
  if (provenance.kind === "origin-default") return "remote default (origin/HEAD)";
  return reporting ? `${provenance.source} baseline` : ".gitmodules baseline";
}

export function resolveBaselines(repoRoot: string, repo: Repo): BaselineResolution {
  const manifestBaseline = repo.branch || resolveOriginHead(aliasDir(repoRoot, repo.alias));
  if (manifestBaseline === null) {
    return {
      ok: false,
      reason: `origin/HEAD could not be resolved for "${repo.alias}". Declare "branch" in oms.yaml or repair origin HEAD (git remote set-head origin -a inside oms/${repo.alias}).`,
    };
  }
  const observations: BaselineObservation[] = [{ branch: manifestBaseline, provenance: { kind: repo.branch ? "manifest" : "origin-default" } }];
  const metadata = observeMetadata(repoRoot, repo.alias);
  if (metadata.errors.length) return { ok: false, reason: metadata.errors[0] };
  let drifted = false;
  for (const source of metadata.sources) {
    if (!source.ok) return { ok: false, reason: source.refusal };
    if (source.branch !== null) {
      observations.push({ branch: source.branch, provenance: { kind: "gitmodules", source: source.source } });
      if (source.branch !== manifestBaseline) drifted = true;
    }
  }
  return {
    ok: true,
    protectedReasons: firstBaselines(observations).map(({ branch, provenance }) => ({ branch, reason: renderReason(provenance, false) })),
    driftWarning: drifted ? `${repo.alias}: .gitmodules baseline metadata differs from oms.yaml; protecting both. Run "oms sync ${repo.alias}" to reconcile.` : null,
  };
}

export function reportBaselines(
  repoRoot: string,
  repo: Repo,
  localBranches: string[],
  originHeadReliable: boolean,
): BaselineReport {
  const observations: BaselineObservation[] = [];
  const warnings: string[] = [];
  let manifestBaseline: string | null = null;
  if (repo.branch) {
    manifestBaseline = repo.branch;
    observations.push({ branch: repo.branch, provenance: { kind: "manifest" } });
  } else if (!originHeadReliable) {
    warnings.push("origin/HEAD is not reliable because origin could not be refreshed successfully");
  } else {
    manifestBaseline = resolveOriginHead(aliasDir(repoRoot, repo.alias));
    if (manifestBaseline === null) warnings.push("origin/HEAD could not be resolved after refreshing origin");
    else observations.push({ branch: manifestBaseline, provenance: { kind: "origin-default" } });
  }
  const metadata = observeMetadata(repoRoot, repo.alias);
  warnings.push(...metadata.errors);
  for (const source of metadata.sources) {
    if (!source.ok) warnings.push(source.warning);
    else if (source.branch !== null) observations.push({ branch: source.branch, provenance: { kind: "gitmodules", source: source.source } });
  }
  const reliable = firstBaselines(observations);
  if (manifestBaseline !== null && reliable.some(({ branch, provenance }) => provenance.kind === "gitmodules" && branch !== manifestBaseline)) {
    warnings.push(`.gitmodules baseline metadata differs from ${repo.branch ? "oms.yaml" : "origin/HEAD"}`);
  }
  const baselines = reliable.map(({ branch, provenance }) => ({ branch, reason: renderReason(provenance, true) })).sort((a, b) => a.branch.localeCompare(b.branch));
  const localSet = new Set(localBranches);
  const unmatched = baselines.map(({ branch }) => branch).filter((branch) => !localSet.has(branch));
  const state = baselines.length === 0 ? "unknown" : warnings.length > 0 ? "incomplete" : "known";
  return { state, baselines, unmatched, warnings };
}
