import { cancel, log, multiselect, select, text } from "@clack/prompts";
import { dim, pad, uniqueAliases } from "./env.js";
import { aliasDir, isDirty, submoduleInitialized } from "./git.js";
import { guardedMultiselect, isCancel, promptQueueActive } from "./prompt-adapter.js";
import { gitlinkState, inferAliasFromCwd, recordVerdict } from "./status.js";
import type { ManageCommand, Repo, SourcesOptions } from "./types.js";

/**
 * Whether an interactive prompt can be completed: a real TTY, or a guarded test response queue
 * standing in for one. Prompts must not open without this, or the awaited prompt never settles.
 */
function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY) || promptQueueActive();
}

/** Names of a repo's non-origin remotes, in declared order (origin is shown via its URL column). */
function extraRemoteNames(repo: Repo): string[] {
  return Object.keys(repo.remotes).filter((name) => name !== "origin");
}

export function printList(repos: Repo[]): void {
  const extras = (r: Repo) => {
    const names = extraRemoteNames(r);
    return names.length > 0 ? ` (+${names.join(",")})` : "";
  };
  const aliasW = Math.max("ALIAS".length, ...repos.map((r) => r.alias.length));
  const urlW = Math.max(
    "ORIGIN".length,
    ...repos.map((r) => (r.remotes.origin + extras(r)).length),
  );
  console.log(dim(`${pad("ALIAS", aliasW)}  ${pad("ORIGIN", urlW)}  BRANCH`));
  for (const r of repos) {
    console.log(`${pad(r.alias, aliasW)}  ${pad(r.remotes.origin + extras(r), urlW)}  ${r.branch ?? ""}`);
  }
}

export async function selectInteractive(repos: Repo[], actionLabel: string): Promise<Repo[] | null> {
  const choice = await guardedMultiselect<string>({
    message: `Select source repos to ${actionLabel} (space to toggle, enter to confirm)`,
    options: repos.map((r) => ({
      value: r.alias,
      label: r.alias,
      hint: r.branch ? `branch: ${r.branch}` : undefined,
    })),
    required: true,
  });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    return null;
  }
  return choice
    .map((alias) => repos.find((r) => r.alias === alias))
    .filter((r): r is Repo => r !== undefined);
}

/**
 * Resolve a single alias for a per-repo branch command (switch/checkout). An explicit alias is
 * validated and must be a synced submodule; when omitted, the user picks one interactively from the
 * synced submodules. Returns null (with a clear message) on an unknown/unsynced alias, an empty set,
 * a non-interactive shell, or cancellation.
 */
export async function resolveInitializedAlias(
  repos: Repo[],
  repoRoot: string,
  alias: string | undefined,
  actionLabel: string,
): Promise<Repo | null> {
  if (alias) {
    const repo = repos.find((r) => r.alias === alias);
    if (!repo) {
      log.error(`Unknown alias "${alias}". Use "oms sync --list" to see registered aliases.`);
      return null;
    }
    if (!submoduleInitialized(repoRoot, alias)) {
      log.error(`${alias}: not synced. Run "oms sync ${alias}" first.`);
      return null;
    }
    return repo;
  }

  const initialized = repos.filter((r) => submoduleInitialized(repoRoot, r.alias));
  if (initialized.length === 0) {
    log.error(`No synced submodules available for "oms ${actionLabel}". Run "oms sync" first.`);
    return null;
  }
  if (!process.stdin.isTTY) {
    log.error(`No alias given and stdin is not a TTY. Pass an alias: "oms ${actionLabel} <alias>".`);
    return null;
  }
  const choice = await select({
    message: `Select a source repo for "oms ${actionLabel}"`,
    options: initialized.map((r) => ({
      value: r.alias,
      label: r.alias,
      hint: r.branch ? `branch: ${r.branch}` : undefined,
    })),
  });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    return null;
  }
  return initialized.find((r) => r.alias === (choice as string)) ?? null;
}

/** Sentinel chosen in pickBranch to create a new branch instead of selecting an existing one. */
const CREATE_NEW_BRANCH = "\0create-new-branch";

/**
 * Prompt for a branch from the given list. When allowCreate is set, a "create new branch" option
 * collects a name via a text prompt. Returns null (with a clear message) on a non-interactive shell,
 * an empty list with no create option, an empty name, or cancellation.
 */
export async function pickBranch(
  branches: string[],
  message: string,
  allowCreate: boolean,
): Promise<string | null> {
  if (!process.stdin.isTTY) {
    log.error(`No branch given and stdin is not a TTY. Pass a branch name explicitly.`);
    return null;
  }
  if (branches.length === 0 && !allowCreate) {
    log.error(`No branches available to select.`);
    return null;
  }
  const options = [
    ...(allowCreate ? [{ value: CREATE_NEW_BRANCH, label: "+ create new branch" }] : []),
    ...branches.map((b) => ({ value: b, label: b })),
  ];
  const choice = await select({ message, options });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    return null;
  }
  if (choice === CREATE_NEW_BRANCH) {
    const name = await text({ message: "New branch name", placeholder: "feature/login" });
    if (isCancel(name)) {
      cancel("Cancelled.");
      return null;
    }
    const trimmed = (name as string).trim();
    if (!trimmed) {
      log.error("Branch name is empty.");
      return null;
    }
    return trimmed;
  }
  return choice as string;
}

/**
 * Decide which remote(s) a fetch/pull/push targets for one repo. Honors an explicit --remote list,
 * otherwise prompts interactively on a TTY (origin preselected) and falls back to origin off-TTY.
 * pull is restricted to a single remote since --ff-only can advance to at most one. Returns the
 * resolved remote names, or null when the request is invalid or the prompt was cancelled.
 */
export async function resolveRemotes(
  repo: Repo,
  requested: string[] | undefined,
  command: ManageCommand,
): Promise<string[] | null> {
  const declared = Object.keys(repo.remotes);

  if (requested && requested.length > 0) {
    const unique = uniqueAliases(requested);
    const unknown = unique.filter((name) => !declared.includes(name));
    if (unknown.length > 0) {
      log.error(
        `${repo.alias}: unknown remote(s): ${unknown.join(", ")}. Declared: ${declared.join(", ")}.`,
      );
      return null;
    }
    if (command === "pull" && unique.length > 1) {
      log.error(`${repo.alias}: pull targets a single remote (git pull --ff-only can advance only one).`);
      return null;
    }
    return unique;
  }

  // No explicit remote: a lone origin needs no prompt, and a non-interactive shell defaults to origin.
  if (declared.length === 1) return declared;
  if (!process.stdin.isTTY) return ["origin"];

  if (command === "pull") {
    const choice = await select({
      message: `${repo.alias}: select a remote to ${command}`,
      options: declared.map((name) => ({ value: name, label: name, hint: repo.remotes[name] })),
      initialValue: "origin",
    });
    if (isCancel(choice)) {
      cancel("Cancelled.");
      return null;
    }
    return [choice as string];
  }

  const choice = await multiselect({
    message: `${repo.alias}: select remote(s) to ${command} (space to toggle, enter to confirm)`,
    options: declared.map((name) => ({ value: name, label: name, hint: repo.remotes[name] })),
    initialValues: ["origin"],
    required: true,
  });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    return null;
  }
  return choice as string[];
}

export async function selectRepos(
  repos: Repo[],
  aliases: string[],
  options: SourcesOptions,
  actionLabel: string,
): Promise<Repo[] | null> {
  if (options.all) return repos;

  if (aliases.length === 0) {
    // A prompt that cannot be completed would never settle, so name the missing selection instead.
    if (!canPrompt()) {
      log.error(
        `No alias given and stdin is not a TTY. Pass an alias ("oms ${actionLabel} <alias>") or select every repo with "oms ${actionLabel} --all".`,
      );
      return null;
    }
    return selectInteractive(repos, actionLabel);
  }

  const unknown = aliases.filter((a) => !repos.some((r) => r.alias === a));
  if (unknown.length > 0) {
    log.error(
      `Unknown alias(es): ${unknown.join(", ")}. Use "oms sync --list" to see available aliases.`,
    );
    return null;
  }

  const byAlias = new Map(repos.map((repo) => [repo.alias, repo]));
  return uniqueAliases(aliases).map((alias) => byAlias.get(alias)!);
}

type AliasResolution =
  | { kind: "alias"; alias: string }
  | { kind: "noop" }
  | { kind: "error" };

/**
 * Aliases a command can act on right now: commit wants dirty submodules, record wants pointers it can
 * actually record. `pin === "moved"` alone is not enough for record — a staged/worktree split also
 * reports `moved`, so the record filter composes `pin` with the shared record verdict rather than
 * re-deriving recordability and drifting from what `oms record` enforces.
 */
function commandCandidates(repos: Repo[], repoRoot: string, command: "commit" | "record"): string[] {
  return repos
    .filter((r) => {
      if (command === "commit") {
        return submoduleInitialized(repoRoot, r.alias) && isDirty(aliasDir(repoRoot, r.alias));
      }
      // pin covers conflicted/missing/uninitialized; the verdict covers split and unmoved pointers.
      const state = gitlinkState(repoRoot, r.alias);
      return state.pin === "moved" && recordVerdict(state, r.alias).kind === "recordable";
    })
    .map((r) => r.alias);
}

/** Wording for the empty-candidate no-op and the sole-candidate auto-selection. */
function candidateLabels(command: "commit" | "record"): { empty: string; sole: string } {
  return command === "commit"
    ? { empty: "Nothing to commit in any submodule.", sole: "dirty submodule" }
    : { empty: "Nothing to record for any submodule.", sole: "moved pointer" };
}

/** Validate explicitly named aliases against the manifest, preserving the shared error wording. */
function knownAliases(repos: Repo[], aliases: string[]): string[] | null {
  const unknown = aliases.filter((a) => !repos.some((r) => r.alias === a));
  if (unknown.length > 0) {
    log.error(
      `Unknown alias${unknown.length > 1 ? "es" : ""} "${unknown.join(", ")}". Use "oms sync --list" to see registered aliases.`,
    );
    return null;
  }
  return uniqueAliases(aliases);
}

/**
 * Resolve a single alias for commit: explicit argument, then current-path inference, then an
 * interactive candidate list, then a non-interactive alias-required failure. Interactive zero
 * candidates is a no-op exit 0; one candidate auto-selects; several show a picker.
 */
export async function resolveCommandAlias(
  repos: Repo[],
  repoRoot: string,
  alias: string | undefined,
  command: "commit" | "record",
): Promise<AliasResolution> {
  if (alias) {
    if (!repos.some((r) => r.alias === alias)) {
      log.error(`Unknown alias "${alias}". Use "oms sync --list" to see registered aliases.`);
      return { kind: "error" };
    }
    return { kind: "alias", alias };
  }

  const inferred = inferAliasFromCwd(repoRoot, repos);
  if (inferred) return { kind: "alias", alias: inferred };

  if (!process.stdin.isTTY) {
    log.error(`No alias given and stdin is not a TTY. Pass an alias: "oms ${command} <alias>".`);
    return { kind: "error" };
  }

  const candidates = commandCandidates(repos, repoRoot, command);
  const labels = candidateLabels(command);

  if (candidates.length === 0) {
    log.info(labels.empty);
    return { kind: "noop" };
  }
  if (candidates.length === 1) {
    log.info(`Selected "${candidates[0]}" (the only ${labels.sole}).`);
    return { kind: "alias", alias: candidates[0] };
  }

  const choice = await select({
    message: `Select a submodule to ${command}`,
    options: candidates.map((a) => ({ value: a, label: a })),
  });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    return { kind: "error" };
  }
  return { kind: "alias", alias: choice as string };
}

/** How a record selection was made; `--all` and the picker allow per-alias skips, a named list does not. */
export type AliasSetResolution =
  | { kind: "aliases"; aliases: string[]; explicit: boolean }
  | { kind: "noop" }
  | { kind: "error" };

/**
 * Resolve the alias set for record: `--all` or an explicit list first, then current-path inference,
 * then an interactive multi-select of moved pointers, then a non-interactive selection-required
 * failure. `explicit` marks a selection the user named, whose per-alias failures must not be skipped.
 */
export async function resolveRecordAliases(
  repos: Repo[],
  repoRoot: string,
  aliases: string[],
  options: SourcesOptions,
): Promise<AliasSetResolution> {
  if (options.all) {
    return { kind: "aliases", aliases: repos.map((r) => r.alias), explicit: false };
  }

  if (aliases.length > 0) {
    const known = knownAliases(repos, aliases);
    if (!known) return { kind: "error" };
    return { kind: "aliases", aliases: known, explicit: true };
  }

  const inferred = inferAliasFromCwd(repoRoot, repos);
  if (inferred) return { kind: "aliases", aliases: [inferred], explicit: true };

  if (!canPrompt()) {
    log.error(
      `No alias given and stdin is not a TTY. Pass an alias ("oms record <alias>") or record every moved pointer with "oms record --all".`,
    );
    return { kind: "error" };
  }

  const candidates = commandCandidates(repos, repoRoot, "record");
  const labels = candidateLabels("record");

  if (candidates.length === 0) {
    log.info(labels.empty);
    return { kind: "noop" };
  }
  if (candidates.length === 1) {
    log.info(`Selected "${candidates[0]}" (the only ${labels.sole}).`);
    return { kind: "aliases", aliases: candidates, explicit: false };
  }

  const choice = await guardedMultiselect<string>({
    message: "Select submodules to record (space to toggle, enter to confirm)",
    options: candidates.map((a) => ({ value: a, label: a })),
    required: true,
  });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    return { kind: "error" };
  }
  // Candidates are filtered by the shared record verdict, so a chosen alias is already recordable.
  return { kind: "aliases", aliases: choice, explicit: false };
}
