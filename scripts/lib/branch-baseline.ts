import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { aliasDir, resolveOriginHead, runGit, submodulePath } from "./git.js";
import type { Repo } from "./types.js";

/** A protected branch and the human-readable reason it cannot be deleted. */
export type ProtectedReason = { branch: string; reason: string };

/** Baseline resolution outcome: the protected branches, or a fail-closed reason keyed to its source. */
export type BaselineResolution =
  | { ok: true; protectedReasons: ProtectedReason[]; driftWarning: string | null }
  | { ok: false; reason: string };

export type BaselineReport = {
  state: "known" | "incomplete" | "unknown";
  baselines: ProtectedReason[];
  unmatched: string[];
  warnings: string[];
};

/** One reliable version of `.gitmodules` to consult for the selected alias's recorded branch. */
type GitmodulesSource = {
  label: string;
  configArgs: string[];
  rawContent: string;
};

function readGitConfigValues(
  repoRoot: string,
  configArgs: string[],
  key: string,
): { ok: true; values: string[] } | { ok: false } {
  const r = runGit(repoRoot, ["config", ...configArgs, "--get-all", key]);
  if (!r.success) return r.exitCode === 1 ? { ok: true, values: [] } : { ok: false };
  return { ok: true, values: r.stdout.split("\n").map((s) => s.trim()).filter((s) => s.length > 0) };
}

/** Number of `[submodule "<path>"]` section headers in raw config content. */
function countSectionHeaders(content: string, path: string): number {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^\\s*\\[submodule "${escaped}"\\]\\s*$`);
  return content.split("\n").filter((line) => header.test(line)).length;
}

/** Collect every readable `.gitmodules` version and identify each source that could not be inspected. */
function collectSources(repoRoot: string): { sources: GitmodulesSource[]; errors: string[] } {
  const sources: GitmodulesSource[] = [];
  const errors: string[] = [];

  const worktreePath = join(repoRoot, ".gitmodules");
  if (existsSync(worktreePath)) {
    try {
      sources.push({
        label: "working tree .gitmodules",
        configArgs: ["--file", worktreePath],
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
      configArgs: ["--blob", `:${stage}:.gitmodules`],
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
        configArgs: ["--blob", "HEAD:.gitmodules"],
        rawContent: show.stdout,
      });
    }
  }

  return { sources, errors };
}

/**
 * Resolve every applicable baseline branch for the selected alias: the explicit `oms.yaml` branch or
 * (when omitted) the remote default `origin/HEAD`, plus every branch recorded in a present, reliable
 * `.gitmodules` version. Fails closed with the source identified on an unreadable version, invalid
 * config syntax, a duplicate selected-alias section, or multiple `path`/`branch` values.
 */
export function resolveBaselines(repoRoot: string, repo: Repo): BaselineResolution {
  const path = submodulePath(repo.alias);
  const reasons = new Map<string, string>();
  const add = (branch: string, reason: string) => {
    if (!reasons.has(branch)) reasons.set(branch, reason);
  };

  if (repo.branch) {
    add(repo.branch, "oms.yaml baseline");
  } else {
    const originHead = resolveOriginHead(aliasDir(repoRoot, repo.alias));
    if (originHead === null) {
      return {
        ok: false,
        reason:
          `origin/HEAD could not be resolved for "${repo.alias}". Declare "branch" in oms.yaml or repair origin HEAD (git remote set-head origin -a inside oms/${repo.alias}).`,
      };
    }
    add(originHead, "remote default (origin/HEAD)");
  }

  const collected = collectSources(repoRoot);
  if (collected.errors.length > 0) return { ok: false, reason: collected.errors[0] };

  const gitmodulesBranches = new Set<string>();
  for (const source of collected.sources) {
    if (countSectionHeaders(source.rawContent, path) > 1) {
      return { ok: false, reason: `${source.label} has duplicate "${path}" submodule sections; repair it, then retry` };
    }
    // A malformed version makes --list fail while the content is non-empty; treat that as invalid syntax.
    if (source.rawContent.trim().length > 0 && !runGit(repoRoot, ["config", ...source.configArgs, "--list"]).success) {
      return { ok: false, reason: `${source.label} has invalid Git config syntax; repair it, then retry` };
    }
    const paths = readGitConfigValues(repoRoot, source.configArgs, `submodule.${path}.path`);
    if (!paths.ok) {
      return { ok: false, reason: `${source.label} path values could not be read; retry once Git is idle` };
    }
    if (paths.values.length > 1) {
      return { ok: false, reason: `${source.label} has multiple "path" values for "${path}"; repair it, then retry` };
    }
    const branches = readGitConfigValues(repoRoot, source.configArgs, `submodule.${path}.branch`);
    if (!branches.ok) {
      return { ok: false, reason: `${source.label} branch values could not be read; retry once Git is idle` };
    }
    if (branches.values.length > 1) {
      return { ok: false, reason: `${source.label} has multiple "branch" values for "${path}"; repair it, then retry` };
    }
    if (branches.values.length === 1) gitmodulesBranches.add(branches.values[0]);
  }

  for (const branch of gitmodulesBranches) add(branch, ".gitmodules baseline");

  // Drift: the recorded baselines disagree with the manifest-derived baseline (explicit or origin default).
  const manifestBaselines = new Set(
    [...reasons.entries()].filter(([, reason]) => reason !== ".gitmodules baseline").map(([b]) => b),
  );
  const drifted = [...gitmodulesBranches].some((b) => !manifestBaselines.has(b));
  const driftWarning = drifted
    ? `${repo.alias}: .gitmodules baseline metadata differs from oms.yaml; protecting both. Run "oms sync ${repo.alias}" to reconcile.`
    : null;

  const protectedReasons = [...reasons.entries()].map(([branch, reason]) => ({ branch, reason }));
  return { ok: true, protectedReasons, driftWarning };
}

/** Report every reliable baseline without blocking a read-only inventory on unreliable metadata. */
export function reportBaselines(
  repoRoot: string,
  repo: Repo,
  localBranches: string[],
  originHeadReliable: boolean,
): BaselineReport {
  const path = submodulePath(repo.alias);
  const reasons = new Map<string, string>();
  const warnings: string[] = [];
  const add = (branch: string, reason: string) => {
    if (!reasons.has(branch)) reasons.set(branch, reason);
  };

  let manifestBaseline: string | null = null;
  if (repo.branch) {
    manifestBaseline = repo.branch;
    add(repo.branch, "oms.yaml baseline");
  } else if (!originHeadReliable) {
    warnings.push("origin/HEAD is not reliable because origin could not be refreshed successfully");
  } else {
    const originHead = resolveOriginHead(aliasDir(repoRoot, repo.alias));
    if (originHead === null) {
      warnings.push("origin/HEAD could not be resolved after refreshing origin");
    } else {
      manifestBaseline = originHead;
      add(originHead, "remote default (origin/HEAD)");
    }
  }

  const collected = collectSources(repoRoot);
  warnings.push(...collected.errors);
  for (const source of collected.sources) {
    if (countSectionHeaders(source.rawContent, path) > 1) {
      warnings.push(`${source.label} has duplicate "${path}" submodule sections`);
      continue;
    }
    if (source.rawContent.trim().length > 0 && !runGit(repoRoot, ["config", ...source.configArgs, "--list"]).success) {
      warnings.push(`${source.label} has invalid Git config syntax`);
      continue;
    }
    const paths = readGitConfigValues(repoRoot, source.configArgs, `submodule.${path}.path`);
    if (!paths.ok) {
      warnings.push(`${source.label} path values could not be read`);
      continue;
    }
    if (paths.values.length > 1) {
      warnings.push(`${source.label} has multiple "path" values for "${path}"`);
      continue;
    }
    const branches = readGitConfigValues(repoRoot, source.configArgs, `submodule.${path}.branch`);
    if (!branches.ok) {
      warnings.push(`${source.label} branch values could not be read`);
      continue;
    }
    if (branches.values.length > 1) {
      warnings.push(`${source.label} has multiple "branch" values for "${path}"`);
      continue;
    }
    if (branches.values.length === 1) add(branches.values[0], `${source.label} baseline`);
  }

  const gitmodulesBaselines = [...reasons.entries()]
    .filter(([, reason]) => reason.includes(".gitmodules"))
    .map(([branch]) => branch);
  if (manifestBaseline !== null && gitmodulesBaselines.some((branch) => branch !== manifestBaseline)) {
    warnings.push(`.gitmodules baseline metadata differs from ${repo.branch ? "oms.yaml" : "origin/HEAD"}`);
  }

  const baselines = [...reasons.entries()]
    .map(([branch, reason]) => ({ branch, reason }))
    .sort((a, b) => a.branch.localeCompare(b.branch));
  const localSet = new Set(localBranches);
  const unmatched = baselines.map(({ branch }) => branch).filter((branch) => !localSet.has(branch));
  const state = baselines.length === 0 ? "unknown" : warnings.length > 0 ? "incomplete" : "known";
  return { state, baselines, unmatched, warnings };
}
