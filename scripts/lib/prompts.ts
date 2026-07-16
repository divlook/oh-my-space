import { cancel, isCancel, log, multiselect, select, text } from "@clack/prompts";
import { dim, pad, uniqueAliases } from "./env.js";
import { aliasDir, isDirty, submoduleInitialized } from "./git.js";
import { gitlinkState, inferAliasFromCwd } from "./status.js";
import type { ManageCommand, Repo, SourcesOptions } from "./types.js";

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
  const choice = await multiselect({
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
 * Resolve a single alias for commit/record: explicit argument, then current-path inference, then an
 * interactive command-specific candidate list, then a non-interactive alias-required failure. Candidate
 * filters are command-specific (commit: dirty submodules; record: moved pointers). Interactive zero
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

  const candidates = repos
    .filter((r) =>
      command === "commit"
        ? submoduleInitialized(repoRoot, r.alias) && isDirty(aliasDir(repoRoot, r.alias))
        : gitlinkState(repoRoot, r.alias).pin === "moved",
    )
    .map((r) => r.alias);

  if (candidates.length === 0) {
    log.info(
      command === "commit"
        ? "Nothing to commit in any submodule."
        : "Nothing to record for any submodule.",
    );
    return { kind: "noop" };
  }
  if (candidates.length === 1) {
    log.info(
      `Selected "${candidates[0]}" (the only ${command === "commit" ? "dirty submodule" : "moved pointer"}).`,
    );
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
