import { cancel, log } from "@clack/prompts";
import { dim, pad, uniqueAliases } from "./env.js";
import { aliasDir, isDirty, submoduleInitialized } from "./git.js";
import { canPrompt, guardedMultiselect, guardedSelect, guardedText, isCancel } from "./prompt-adapter.js";
import { gitlinkState, inferAliasFromCwd, recordVerdict } from "./workspace-state.js";
import type { ManageCommand, Repo, SourcesOptions } from "./types.js";

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

export async function selectRepoAlias(
  repos: Repo[],
  alias: string | undefined,
  actionLabel: string,
): Promise<Repo | null> {
  let repo: Repo | undefined;
  if (alias) {
    repo = repos.find((candidate) => candidate.alias === alias);
    if (!repo) {
      log.error(`Unknown alias "${alias}". Use "oms sync --list" to see registered aliases.`);
      return null;
    }
  } else if (repos.length === 0) {
    log.error(`No source repos available for "oms ${actionLabel}". Add one to oms.yaml first.`);
    return null;
  } else if (repos.length === 1) {
    repo = repos[0];
    log.info(`Selected "${repo.alias}" (the only configured source repo).`);
  } else {
    if (!canPrompt()) {
      log.error(
        `Several source repos qualify for "oms ${actionLabel}" (${repos.map((candidate) => candidate.alias).join(", ")}) and stdin is not a TTY. Pass an alias: "oms ${actionLabel} <alias>".`,
      );
      return null;
    }
    const choice = await guardedSelect<string>({
      message: `Select a source repo for "oms ${actionLabel}"`,
      options: repos.map((candidate) => ({
        value: candidate.alias,
        label: candidate.alias,
        hint: candidate.branch ? `branch: ${candidate.branch}` : undefined,
      })),
    });
    if (isCancel(choice)) {
      cancel("Cancelled.");
      return null;
    }
    repo = repos.find((candidate) => candidate.alias === (choice as string));
    if (!repo) return null;
  }

  return repo;
}

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
  if (!canPrompt()) {
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
  const choice = await guardedSelect<string>({ message, options });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    return null;
  }
  if (choice === CREATE_NEW_BRANCH) {
    const name = await guardedText({ message: "New branch name", placeholder: "feature/login" });
    if (isCancel(name)) {
      cancel("Cancelled.");
      return null;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      log.error("Branch name is empty.");
      return null;
    }
    return trimmed;
  }
  return choice;
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
  if (!canPrompt()) return ["origin"];

  if (command === "pull") {
    const choice = await guardedSelect<string>({
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

  const choice = await guardedMultiselect<string>({
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

function commandCandidates(repos: Repo[], repoRoot: string, command: "commit" | "record"): string[] {
  return repos.filter((repo) => {
    if (command === "commit") return submoduleInitialized(repoRoot, repo.alias) && isDirty(aliasDir(repoRoot, repo.alias));
    const state = gitlinkState(repoRoot, repo.alias);
    return state.pin === "moved" && recordVerdict(state, repo.alias).kind === "recordable";
  }).map((repo) => repo.alias);
}

function candidateLabels(command: "commit" | "record"): { empty: string; sole: string } {
  return command === "commit"
    ? { empty: "Nothing to commit in any submodule.", sole: "dirty submodule" }
    : { empty: "Nothing to record for any submodule.", sole: "moved pointer" };
}

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

export async function resolveCommitAlias(
  repos: Repo[],
  repoRoot: string,
  alias: string | undefined,
): Promise<AliasResolution> {
  const command = "commit";
  if (alias) {
    if (!repos.some((r) => r.alias === alias)) {
      log.error(`Unknown alias "${alias}". Use "oms sync --list" to see registered aliases.`);
      return { kind: "error" };
    }
    return { kind: "alias", alias };
  }

  const inferred = inferAliasFromCwd(repoRoot, repos);
  if (inferred) return { kind: "alias", alias: inferred };

  // Count candidates before consulting the terminal. Zero and one need no human intent, so gating
  // them on stdin made the same repository state succeed in a terminal and fail in a pipe.
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
  if (!canPrompt()) {
    log.error(
      `Several submodules qualify for "oms ${command}" (${candidates.join(", ")}) and stdin is not a TTY. Pass one: "oms ${command} <alias>".`,
    );
    return { kind: "error" };
  }

  const choice = await guardedSelect<string>({
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
type AliasSetResolution =
  | { kind: "aliases"; aliases: string[]; explicit: boolean }
  | { kind: "noop" }
  | { kind: "error" };

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
  if (!canPrompt()) {
    log.error(
      `Several moved pointers qualify for "oms record" (${candidates.join(", ")}) and stdin is not a TTY. Pass an alias ("oms record <alias>") or record every moved pointer with "oms record --all".`,
    );
    return { kind: "error" };
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
  return { kind: "aliases", aliases: choice, explicit: false };
}
