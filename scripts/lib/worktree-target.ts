import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { cancel, log } from "@clack/prompts";
import { guardedSelect, isCancel, promptQueueActive } from "./prompt-adapter.js";
import type { Repo } from "./types.js";
import {
  inspectWorktreeInventory,
  inspectWorktreeState,
  type ClassifiedWorktree,
  type WorktreeState,
} from "./worktree-inspection.js";
import { parseAlias, parseManagedTarget, type ManagedTarget } from "./worktree-paths.js";
import { readWorkspaceOwnership } from "./workspace-mutation.js";

export type ParsedWorktreeTarget =
  | { kind: "alias"; alias: string }
  | { kind: "worktree"; alias: string; name: string };

export type WorktreeTargetCommand = "commit" | "pull" | "push" | "branch-switch" | "branch-checkout";

export type ResolvedWorktreeTarget = {
  repo: Repo;
  entry: ClassifiedWorktree;
  state: WorktreeState;
  target: ManagedTarget;
  source: "explicit" | "current" | "sole" | "interactive";
};

type Candidate = Omit<ResolvedWorktreeTarget, "source"> & { viable: boolean; reason: string | null };

/** Parse an alias or alias/name without selecting a candidate. */
export function parseWorktreeTarget(value: string): ParsedWorktreeTarget {
  if (!value.includes("/")) return { kind: "alias", alias: parseAlias(value) };
  const target = parseManagedTarget(value);
  return { kind: "worktree", ...target };
}

function interactive(): boolean {
  return Boolean(process.stdin.isTTY) || promptQueueActive();
}

function viabilityReason(command: WorktreeTargetCommand, state: WorktreeState): string | null {
  if (state.operation) return `${state.operation} in progress`;
  if (["commit", "pull", "push"].includes(command) && state.detached) return "detached HEAD";
  if (command === "pull" && state.dirty) return "dirty working tree";
  return null;
}

function collectCandidates(workspaceRoot: string, repos: Repo[], alias: string | null): Candidate[] {
  const ownership = readWorkspaceOwnership(workspaceRoot);
  if (!ownership) throw new Error("Workspace ownership is missing; run a mutating OMS command first.");
  const candidates: Candidate[] = [];
  for (const repo of repos) {
    if (alias && repo.alias !== alias) continue;
    const inventory = inspectWorktreeInventory(workspaceRoot, repo.alias, ownership.workspaceId);
    for (const entry of inventory.worktrees) {
      if (!entry.managed || !entry.name) continue;
      let state: WorktreeState;
      try {
        if (entry.stale || entry.ownershipError || !existsSync(entry.path)) {
          throw new Error(entry.ownershipError ?? "stale or missing path");
        }
        state = inspectWorktreeState(entry.path);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        candidates.push({
          repo,
          entry,
          state: {
            branch: null,
            head: entry.head,
            detached: entry.branch === null,
            trackingBranch: null,
            ahead: null,
            behind: null,
            changes: { staged: 0, unstaged: 0, untracked: 0 },
            dirty: false,
            ignored: 0,
            nestedRepositories: 0,
            operation: null,
            recoverable: false,
            recoverableRefs: [],
          },
          target: { alias: repo.alias, name: entry.name },
          viable: false,
          reason,
        });
        continue;
      }
      candidates.push({
        repo,
        entry,
        state,
        target: { alias: repo.alias, name: entry.name },
        viable: true,
        reason: null,
      });
    }
  }
  return candidates;
}

function currentCandidate(workspaceRoot: string, candidates: Candidate[]): Candidate | null {
  let cwd: string;
  try {
    cwd = realpathSync(process.cwd());
  } catch {
    return null;
  }
  return candidates
    .filter(({ entry }) => {
      if (!entry.canonicalPath) return false;
      const rel = relative(entry.canonicalPath, cwd);
      return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    })
    .sort((left, right) => (right.entry.canonicalPath?.length ?? 0) - (left.entry.canonicalPath?.length ?? 0))[0] ?? null;
}

function resolved(candidate: Candidate, source: ResolvedWorktreeTarget["source"]): ResolvedWorktreeTarget {
  return { repo: candidate.repo, entry: candidate.entry, state: candidate.state, target: candidate.target, source };
}

/** Resolve a command-viable managed checkout with explicit-target and current-path precedence. */
export async function resolveWorktreeTarget(
  workspaceRoot: string,
  repos: Repo[],
  value: string | undefined,
  command: WorktreeTargetCommand,
): Promise<ResolvedWorktreeTarget | null> {
  let parsed: ParsedWorktreeTarget | null = null;
  try {
    parsed = value ? parseWorktreeTarget(value) : null;
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    return null;
  }
  const alias = parsed?.alias ?? null;
  if (alias && !repos.some((repo) => repo.alias === alias)) {
    log.error(`Unknown repository alias "${alias}".`);
    return null;
  }

  let candidates: Candidate[];
  try {
    candidates = collectCandidates(workspaceRoot, repos, alias);
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    return null;
  }
  for (const candidate of candidates) {
    candidate.reason = candidate.reason ?? viabilityReason(command, candidate.state);
    candidate.viable = candidate.reason === null;
  }

  if (parsed?.kind === "worktree") {
    const candidate = candidates.find(({ target }) => target.alias === parsed.alias && target.name === parsed.name);
    if (!candidate) {
      log.error(`${parsed.alias}/${parsed.name}: is not a registered managed worktree`);
      return null;
    }
    if (!candidate.viable) {
      log.error(`${parsed.alias}/${parsed.name}: cannot ${command} because ${candidate.reason}`);
      return null;
    }
    return resolved(candidate, "explicit");
  }

  const current = currentCandidate(workspaceRoot, candidates);
  let requireExplicitReselection = false;
  if (current) {
    if (current.viable) return resolved(current, "current");
    log.error(`${current.target.alias}/${current.target.name}: current target cannot ${command} because ${current.reason}`);
    if (!interactive()) return null;
    requireExplicitReselection = true;
  }

  const viable = candidates.filter((candidate) => candidate.viable);
  if (viable.length === 1 && !requireExplicitReselection) {
    log.info(`${viable[0].target.alias}/${viable[0].target.name}: selected as the only viable managed worktree`);
    return resolved(viable[0], "sole");
  }
  if (viable.length === 0) {
    log.error(`${alias ?? "workspace"}: no managed worktree is viable for ${command}`);
    return null;
  }
  if (!interactive()) {
    log.error(`Multiple managed worktrees are viable for ${command}; pass an explicit alias/name target.`);
    return null;
  }
  const choice = await guardedSelect<string>({
    message: `Select a managed worktree for ${command}`,
    options: viable.map((candidate) => ({
      value: `${candidate.target.alias}/${candidate.target.name}`,
      label: `${candidate.target.alias}/${candidate.target.name}`,
      hint: candidate.state.branch ?? "detached",
    })),
  });
  if (isCancel(choice)) {
    cancel(`${command} cancelled.`);
    return null;
  }
  const candidate = viable.find(({ target }) => `${target.alias}/${target.name}` === choice);
  return candidate ? resolved(candidate, "interactive") : null;
}

/** List every registered managed target, including entries that may later fail command viability. */
export function listManagedWorktreeTargets(workspaceRoot: string, repos: Repo[]): string[] {
  const ownership = readWorkspaceOwnership(workspaceRoot);
  if (!ownership) throw new Error("Workspace ownership is missing; run a mutating OMS command first.");
  return repos.flatMap((repo) => inspectWorktreeInventory(workspaceRoot, repo.alias, ownership.workspaceId).worktrees
    .filter((entry) => entry.managed && entry.name)
    .map((entry) => `${repo.alias}/${entry.name}`));
}
