import { cancel, log } from "@clack/prompts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_FILENAME } from "./constants.js";
import { aliasDir, currentBranch, listLocalBranches, localBranchOid, redactSensitiveUrls, redactingGitRunner, runGit, runSub, shortOid, submodulePath } from "./git.js";
import { parseManifest } from "./manifest.js";
import { canPrompt, guardedSelect, guardedText, isCancel } from "./prompt-adapter.js";
import { syncWorkspace } from "./sync-workspace.js";
import { attachBranch, gitmodulesBranch } from "./submodule-config.js";
import type { OperationResult, Repo } from "./types.js";
import { aliasRegistration, pendingRegistrationGuidance, type AliasRegistration } from "./alias-registration.js";
import { assertRootTopologySafe } from "./workspace-state.js";



type PrepareResult = { ok: true } | { ok: false; code: number };

type PrepareOptions = {
  command: string;
  /**
   * Whether this command may offer topology-creating registration. True only where a fresh
   * registration could still serve the request; `commit`, `push`, and `branch delete` presuppose
   * local state a new clone cannot contain, so they refuse instead.
   */
  topologyOffer: boolean;
};

const PENDING_ELIGIBLE: Readonly<Record<string, true | undefined>> = {
  fetch: true,
  pull: true,
  commit: true,
  "branch list": true,
  "branch switch": true,
  "branch checkout": true,
  "tree add": true,
};

function readCommitOffer(repoRoot: string): boolean | null {
  try {
    return parseManifest(readFileSync(join(repoRoot, MANIFEST_FILENAME), "utf8")).autoCommit;
  } catch (error) {
    const detail = error instanceof Error ? `: ${redactSensitiveUrls(error.message)}` : "";
    log.error(`Could not determine autoCommit from ${MANIFEST_FILENAME}${detail}. No registration was attempted; fix the problem and rerun.`);
    return null;
  }
}

function commitConsequence(autoCommit: boolean): string {
  return autoCommit
    ? "autoCommit is enabled: sync will try to create a root registration commit"
    : "autoCommit is disabled: sync will not create a root registration commit";
}

function syncForPreparation(repoRoot: string, repos: Repo[], autoCommit: boolean) {
  return syncWorkspace(repoRoot, repos, { commit: autoCommit, delegated: true }, redactingGitRunner);
}


function initializeRegisteredAlias(repoRoot: string, repo: Repo, command: string): PrepareResult {
  log.step(`${repo.alias}: initializing registered submodule`);
  const update = runGit(repoRoot, [
    "-c",
    `submodule.${submodulePath(repo.alias)}.url=${repo.remotes.origin}`,
    "submodule",
    "update",
    "--init",
    "--",
    submodulePath(repo.alias),
  ]);
  if (update.success) {
    // Initialization checks out the pinned commit detached. The shared attachment primitive only
    // attaches a baseline when doing so preserves that commit; divergence remains detached for the
    // caller's command-specific handling.
    const branch = gitmodulesBranch(repoRoot, repo.alias) ?? repo.branch;
    if (branch) {
      const attachment = attachBranch(repoRoot, repo.alias, branch);
      if (attachment.kind === "failed") {
        if (attachment.diagnostic) log.error(attachment.diagnostic);
        log.error(`${repo.alias}: could not attach detached HEAD to "${branch}". Repository state was preserved.`);
        return { ok: false, code: 2 };
      }
    }
    return { ok: true };
  }

  const diagnostic = redactSensitiveUrls(update.stderr.trim());
  if (diagnostic) log.error(diagnostic);
  log.error(
    `${repo.alias}: automatic initialization failed (exit ${update.exitCode}). Git's resumable partial state was preserved. Retry "oms ${command} ${repo.alias}" or repair with "git submodule update --init -- ${submodulePath(repo.alias)}".`,
  );
  return { ok: false, code: 2 };
}


function refuseUnregistered(repo: Repo, command: string): PrepareResult {
  log.error(
    `${repo.alias}: declared in oms.yaml but not registered in the root repository, so it has no local state for "oms ${command}" to act on. Run "oms sync ${repo.alias}" to register it, then retry.`,
  );
  return { ok: false, code: 1 };
}

function prepareExistingAlias(
  repoRoot: string,
  repo: Repo,
  options: PrepareOptions,
  registration: AliasRegistration,
): PrepareResult | null {
  const { command } = options;
  if (registration.kind === "initialized") return { ok: true };
  if (registration.kind === "pending registration") {
    if (Object.hasOwn(PENDING_ELIGIBLE, command)) return { ok: true };
    log.error(`${repo.alias}: ${pendingRegistrationGuidance(repo.alias)}`);
    return { ok: false, code: 1 };
  }
  if (registration.kind === "indeterminate") {
    log.error(`${repo.alias}: ${registration.reason}; retry once Git is idle. Nothing was changed.`);
    return { ok: false, code: 1 };
  }
  if (registration.kind === "registered-uninitialized") return initializeRegisteredAlias(repoRoot, repo, command);
  if (registration.kind === "partially registered") {
    log.error(
      `${repo.alias}: inconsistent root registration (${registration.reason}). Repository state was preserved. Repair it with "oms sync ${repo.alias}", then retry.`,
    );
    return { ok: false, code: 1 };
  }
  return null;
}

function prepareAfterSync(
  repoRoot: string,
  repo: Repo,
  options: PrepareOptions,
  outcome: OperationResult | undefined,
  syncCode: number,
): PrepareResult {
  if (outcome !== "added" && outcome !== "updated") {
    log.error(`${repo.alias}: sync and continue failed. Sync's partial state was preserved.`);
    return { ok: false, code: syncCode || 2 };
  }
  const registration = aliasRegistration(repoRoot, repo.alias);
  if (registration.kind === "unregistered" || registration.kind === "registered-uninitialized") {
    log.error(`${repo.alias}: sync completed but did not produce an initialized registration. Run "oms sync ${repo.alias}" to repair it.`);
    return { ok: false, code: 2 };
  }
  return prepareExistingAlias(repoRoot, repo, options, registration)!;
}

export async function prepareAlias(
  repoRoot: string,
  repo: Repo,
  options: PrepareOptions,
): Promise<PrepareResult> {
  const { command, topologyOffer } = options;
  const existing = prepareExistingAlias(repoRoot, repo, options, aliasRegistration(repoRoot, repo.alias));
  if (existing) return existing;
  if (!topologyOffer) return refuseUnregistered(repo, command);
  if (!canPrompt()) {
    log.error(
      `${repo.alias}: declared in oms.yaml but not registered in the root repository. No topology was changed. Run "oms sync ${repo.alias}", then retry "oms ${command} ${repo.alias}".`,
    );
    return { ok: false, code: 1 };
  }
  const autoCommit = readCommitOffer(repoRoot);
  if (autoCommit === null) return { ok: false, code: 1 };

  const choice = await guardedSelect<string>({
    message: `${repo.alias} is not registered; sync creates root submodule topology. ${commitConsequence(autoCommit)}.`,
    initialValue: "sync",
    options: [
      { value: "sync", label: "sync and continue", hint: `run oms sync ${repo.alias}, then ${command}` },
      { value: "cancel", label: "cancel", hint: "leave root topology unchanged" },
    ],
  });
  if (isCancel(choice) || choice === "cancel") {
    cancel(`Cancelled. No topology was changed. Run "oms sync ${repo.alias}" when ready.`);
    return { ok: false, code: 1 };
  }
  const topology = assertRootTopologySafe(repoRoot, repo.alias);
  if (!topology.safe) {
    log.error(`${repo.alias}: sync cannot start because ${topology.reason} Root state was preserved. Repair it, then run "oms sync ${repo.alias}".`);
    return { ok: false, code: 1 };
  }
  const sync = await syncForPreparation(repoRoot, [repo], autoCommit);
  if (!sync.finalized) {
    log.error(`${repo.alias}: sync and continue failed; "oms ${command}" was not run.`);
    return { ok: false, code: sync.code || 2 };
  }
  return prepareAfterSync(repoRoot, repo, options, sync.outcomes.get(repo.alias), sync.code);
}

type AttachVerdict =
  | { kind: "on-branch"; branch: string }
  | { kind: "attached"; branch: string }
  | { kind: "needs-intent"; oid: string }
  | { kind: "failed" };

/**
 * Attach a detached submodule HEAD when doing so cannot move the working tree: a local branch whose
 * tip is exactly HEAD makes the switch a pure relabel. When none exists, switching would move the
 * checkout, so the caller must collect intent instead.
 */
function attachDetachedHead(repoRoot: string, alias: string): AttachVerdict {
  const dir = aliasDir(repoRoot, alias);
  const current = currentBranch(dir);
  if (current !== null) return { kind: "on-branch", branch: current };

  const head = runGit(dir, ["rev-parse", "--verify", "HEAD^{commit}"]).stdout.trim();
  const at = listLocalBranches(dir).find((branch) => localBranchOid(dir, branch) === head);
  if (at === undefined) return { kind: "needs-intent", oid: shortOid(dir, "HEAD") };

  const switched = runSub(repoRoot, alias, ["switch", at], true);
  if (!switched.success) {
    log.error(`${alias}: could not attach detached HEAD to "${at}". Repository state was preserved.`);
    return { kind: "failed" };
  }
  log.info(`${alias}: attached detached HEAD to "${at}" (same commit).`);
  return { kind: "attached", branch: at };
}

/**
 * Bring a detached submodule HEAD onto a branch, or stop with the reason. The safe relabel happens
 * silently; anything that would move the working tree needs an explicit choice, because the user's
 * checkout position is the thing at risk.
 */
export async function resolveDetachedHead(
  repoRoot: string,
  repo: Repo,
  command: string,
): Promise<PrepareResult> {
  const verdict = attachDetachedHead(repoRoot, repo.alias);
  if (verdict.kind === "failed") return { ok: false, code: 2 };
  if (verdict.kind !== "needs-intent") return { ok: true };

  const baseline = repo.branch;
  if (!canPrompt()) {
    log.error(
      `${repo.alias}: detached HEAD at ${verdict.oid} and no local branch points there, so "oms ${command}" has no branch to act on. Attach one with "oms branch switch ${repo.alias} <branch>".`,
    );
    return { ok: false, code: 1 };
  }

  const CREATE = "\0create";
  const choice = await guardedSelect<string>({
    message: `${repo.alias}: HEAD is detached at ${verdict.oid} with no branch there`,
    options: [
      { value: CREATE, label: "create a branch at this commit", hint: "keeps the current checkout" },
      ...(baseline
        ? [{ value: baseline, label: `switch to ${baseline}`, hint: `moves the working tree off ${verdict.oid}` }]
        : []),
      { value: "\0cancel", label: "cancel", hint: "leave the submodule detached" },
    ],
  });
  if (isCancel(choice) || choice === "\0cancel") {
    cancel(`Cancelled. ${repo.alias} is still detached at ${verdict.oid}.`);
    return { ok: false, code: 1 };
  }

  if (choice === CREATE) {
    const name = await guardedText({ message: `${repo.alias}: new branch name`, placeholder: "work/detached" });
    if (isCancel(name)) {
      cancel(`Cancelled. ${repo.alias} is still detached at ${verdict.oid}.`);
      return { ok: false, code: 1 };
    }
    const trimmed = name.trim();
    if (!trimmed) {
      log.error(`${repo.alias}: branch name is empty.`);
      return { ok: false, code: 1 };
    }
    const created = runSub(repoRoot, repo.alias, ["switch", "-c", trimmed], true);
    if (!created.success) return { ok: false, code: 2 };
    log.success(`${repo.alias}: created ${trimmed} at ${verdict.oid}.`);
    return { ok: true };
  }

  const switched = runSub(repoRoot, repo.alias, ["switch", choice as string], true);
  if (!switched.success) return { ok: false, code: 2 };
  log.success(`${repo.alias}: on ${choice}.`);
  return { ok: true };
}

type BatchPreparation = {
  outcomes: Map<string, "ready" | "skipped" | "failed">;
  cancelled: boolean;
};

/** Prepare a whole selection with at most one topology decision and one delegated sync. */
export async function prepareAliases(
  repoRoot: string,
  repos: Repo[],
  options: PrepareOptions & { explicitSelection: boolean },
): Promise<BatchPreparation> {
  const { command, topologyOffer, explicitSelection } = options;
  const result: BatchPreparation = { outcomes: new Map(), cancelled: false };
  const registrations = new Map(repos.map((repo) => [repo.alias, aliasRegistration(repoRoot, repo.alias)]));
  const unregistered = repos.filter((repo) => registrations.get(repo.alias)!.kind === "unregistered");

  if (unregistered.length > 0 && topologyOffer) {
    if (!canPrompt()) {
      for (const repo of unregistered) {
        log.error(
          `${repo.alias}: declared in oms.yaml but not registered in the root repository. No topology was changed. Run "oms sync ${repo.alias}", then retry "oms ${command}".`,
        );
        result.outcomes.set(repo.alias, "failed");
      }
    } else {
      const autoCommit = readCommitOffer(repoRoot);
      if (autoCommit === null) {
        for (const repo of repos) result.outcomes.set(repo.alias, "failed");
        return result;
      }
      const names = unregistered.map((r) => r.alias).join(", ");
      // Register by default only when the selection named an alias rather than widening the request.
      const syncOption = {
        value: "sync",
        label: unregistered.length > 1 ? "sync all and continue" : "sync and continue",
        hint: `register ${names}, then ${command}`,
      };
      const skipOption = { value: "skip", label: "skip them, continue with the rest", hint: "leave root topology unchanged" };
      const description = unregistered.length === 1
        ? `${names} is not registered`
        : `${unregistered.length} aliases are not registered (${names})`;
      const choice = await guardedSelect<string>({
        message: `${description}; sync creates root submodule topology. ${commitConsequence(autoCommit)}.`,
        initialValue: explicitSelection ? "sync" : "skip",
        options: explicitSelection
          ? [syncOption, skipOption, { value: "cancel", label: "cancel", hint: "perform no operation" }]
          : [skipOption, syncOption, { value: "cancel", label: "cancel", hint: "perform no operation" }],
      });
      if (isCancel(choice) || choice === "cancel") {
        cancel("Cancelled. No topology was changed.");
        result.cancelled = true;
        return result;
      }
      if (choice === "sync") {
        const sync = await syncForPreparation(repoRoot, unregistered, autoCommit);
        if (!sync.finalized) {
          log.error(`sync and continue failed; "oms ${command}" was not run for any alias.`);
          for (const repo of repos) result.outcomes.set(repo.alias, "failed");
          return result;
        }
        for (const repo of unregistered) {
          const prepared = prepareAfterSync(repoRoot, repo, options, sync.outcomes.get(repo.alias), sync.code);
          result.outcomes.set(repo.alias, prepared.ok ? "ready" : "failed");
        }
      } else {
        for (const repo of unregistered) {
          log.warn(`${repo.alias}: skipped (not registered).`);
          result.outcomes.set(repo.alias, "skipped");
        }
      }
    }
  }

  for (const repo of repos) {
    if (result.outcomes.has(repo.alias)) continue;
    const registration = registrations.get(repo.alias)!;
    const prepared = prepareExistingAlias(repoRoot, repo, options, registration)
      ?? refuseUnregistered(repo, command);
    result.outcomes.set(repo.alias, prepared.ok ? "ready" : "failed");
  }
  return result;
}
