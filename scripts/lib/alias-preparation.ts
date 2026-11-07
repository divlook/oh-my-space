import { cancel, log } from "@clack/prompts";
import { aliasDir, currentBranch, listLocalBranches, localBranchOid, redactSensitiveUrls, runGit, runSub, shortOid, submoduleInitialized, submodulePath } from "./git.js";
import { redactingGitRunner } from "./git.js";
import { canPrompt, guardedSelect, guardedText, isCancel } from "./prompt-adapter.js";
import { syncWorkspace } from "./sync-workspace.js";
import { attachBranch, gitmodulesBranch } from "./submodule-config.js";
import { assertRootTopologySafe } from "./workspace-state.js";
import type { Repo } from "./types.js";
import { aliasRegistration, type AliasRegistration } from "./alias-registration.js";



type PrepareResult = { ok: true } | { ok: false; code: number };

type PrepareOptions = {
  command: string;
  /**
   * Whether this command may offer topology-creating registration. True only where a fresh
   * registration could still serve the request; `commit`, `push`, and `branch delete` presuppose
   * local state a new clone cannot contain, so they refuse instead.
   */
  topologyOffer: boolean;
  /**
   * Whether an incomplete root registration blocks the command. Commands that read or change root
   * topology need it settled first; commands confined to the submodule working tree do not, and
   * pending add/remove topology must not stop them — `oms commit` is documented to commit source
   * changes and merely hint about the pending topology afterwards.
   */
  requiresSettledTopology?: boolean;
};


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
  if (registration === "initialized") return { ok: true };
  if (registration === "indeterminate") {
    // Transient, so the remedy is to retry — not to repair a registration that may be perfectly fine.
    log.error(
      `${repo.alias}: the index .gitmodules sources could not be listed; retry once Git is idle. Nothing was changed.`,
    );
    return { ok: false, code: 1 };
  }
  if (registration === "registered-uninitialized") return initializeRegisteredAlias(repoRoot, repo, command);
  if (registration === "partially registered") {
    // A submodule-only command can work in a usable checkout even while root topology is pending;
    // blocking it here would break `oms commit` under pending add topology.
    if (options.requiresSettledTopology === false && submoduleInitialized(repoRoot, repo.alias)) {
      return { ok: true };
    }
    log.error(
      `${repo.alias}: root gitlink and .gitmodules registration are inconsistent or pending addition/removal. Repository state was preserved. Repair it with "oms sync ${repo.alias}", then retry.`,
    );
    return { ok: false, code: 1 };
  }
  return null;
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

  const choice = await guardedSelect<string>({
    message: `${repo.alias} is not registered; sync creates root submodule topology`,
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
    log.error(
      `${repo.alias}: sync cannot start because ${topology.reason} Root state was preserved. Repair it, then run "oms sync ${repo.alias}".`,
    );
    return { ok: false, code: 1 };
  }
  const code = await syncWorkspace(repoRoot, [repo], {}, redactingGitRunner);
  if (code !== 0) {
    log.error(`${repo.alias}: sync and continue failed. Sync's partial state and exit code were preserved.`);
    return { ok: false, code };
  }
  if (!submoduleInitialized(repoRoot, repo.alias)) {
    log.error(`${repo.alias}: sync completed but the submodule is not initialized. Run "oms sync ${repo.alias}" to repair it.`);
    return { ok: false, code: 2 };
  }
  return { ok: true };
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

/**
 * Prepare a whole selection with at most one topology decision. Hoisting the choice out of the
 * per-alias loop keeps `oms pull --all` from asking once per alias and producing one root commit
 * each, which is what a per-alias `prepareAlias` would do.
 */
export async function prepareAliases(
  repoRoot: string,
  repos: Repo[],
  options: PrepareOptions & { explicitSelection: boolean },
): Promise<BatchPreparation> {
  const { command, topologyOffer, explicitSelection } = options;
  const result: BatchPreparation = { outcomes: new Map(), cancelled: false };
  const unregistered: Repo[] = [];

  const registrations = new Map(repos.map((repo) => [repo.alias, aliasRegistration(repoRoot, repo.alias)]));
  for (const repo of repos) {
    if (registrations.get(repo.alias) === "unregistered") unregistered.push(repo);
  }

  let registerUnregistered = false;
  if (unregistered.length > 0 && topologyOffer) {
    if (!canPrompt()) {
      for (const repo of unregistered) {
        log.error(
          `${repo.alias}: declared in oms.yaml but not registered in the root repository. No topology was changed. Run "oms sync ${repo.alias}", then retry "oms ${command}".`,
        );
        result.outcomes.set(repo.alias, "failed");
      }
    } else {
      const names = unregistered.map((r) => r.alias).join(", ");
      // A named alias carries unambiguous intent, so registering is the default. A --all or
      // multi-select sweep named nothing, so a reflexive Enter must not clone and commit topology.
      const syncOption = { value: "sync", label: `sync ${unregistered.length > 1 ? "all" : ""}and continue`.replace("  ", " "), hint: `register ${names}, then ${command}` };
      const skipOption = { value: "skip", label: "skip them, continue with the rest", hint: "leave root topology unchanged" };
      const choice = await guardedSelect<string>({
        message: unregistered.length === 1
          ? `${names} is not registered; sync creates root submodule topology`
          : `${unregistered.length} aliases are not registered (${names}); sync creates root submodule topology`,
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
      registerUnregistered = choice === "sync";
    }
  }

  if (registerUnregistered) {
    for (const repo of unregistered) {
      const topology = assertRootTopologySafe(repoRoot, repo.alias);
      if (topology.safe) continue;
      log.error(`${repo.alias}: sync cannot start because ${topology.reason} Root state was preserved.`);
      result.outcomes.set(repo.alias, "failed");
    }
    const syncable = unregistered.filter((repo) => !result.outcomes.has(repo.alias));
    if (syncable.length > 0) {
      const code = await syncWorkspace(repoRoot, syncable, {}, redactingGitRunner);
      if (code !== 0) {
        log.error(`sync and continue failed. Sync's partial state and exit code were preserved.`);
      }
      // Never ask a second topology question after delegated sync. Complete registrations can
      // continue; aliases left unregistered or partial retain the sync failure and are excluded.
      for (const repo of syncable) {
        const registration = aliasRegistration(repoRoot, repo.alias);
        registrations.set(repo.alias, registration);
        if (registration === "initialized" || registration === "registered-uninitialized") continue;
        log.error(`${repo.alias}: sync and continue did not produce a complete registration.`);
        result.outcomes.set(repo.alias, "failed");
      }
    }
  }

  for (const repo of repos) {
    if (result.outcomes.has(repo.alias)) continue;
    if (!registerUnregistered && registrations.get(repo.alias) === "unregistered") {
      if (topologyOffer && canPrompt()) {
        log.warn(`${repo.alias}: skipped (not registered).`);
        result.outcomes.set(repo.alias, "skipped");
      } else if (!topologyOffer) {
        refuseUnregistered(repo, command);
        result.outcomes.set(repo.alias, "failed");
      }
      continue;
    }
    const prepared = prepareExistingAlias(repoRoot, repo, options, registrations.get(repo.alias)!)!;
    result.outcomes.set(repo.alias, prepared.ok ? "ready" : "failed");
  }
  return result;
}
