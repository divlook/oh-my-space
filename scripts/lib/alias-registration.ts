import { lstatSync, realpathSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { aliasDir, runGit, submoduleInitialized, submodulePath } from "./git.js";

export type AliasRegistration =
  | { kind: "initialized" | "pending registration" | "unregistered" | "registered-uninitialized" }
  | { kind: "partially registered" | "indeterminate"; reason: string };

type Mapping = "absent" | "matching" | "ambiguous" | "invalid" | "unreadable";
type Gitmodules = "absent" | "invalid" | "unreadable" | Map<string, "named" | "matching" | "ambiguous">;

function inspectGitmodules(repoRoot: string, source: string[], paths: ReadonlySet<string>): Gitmodules {
  const config = runGit(repoRoot, ["config", ...source, "--null", "--list"]);
  if (!config.success) {
    return config.exitCode === 3 || /bad config line/i.test(config.stderr) ? "invalid" : "unreadable";
  }

  const sections = new Map<string, "named" | "matching" | "ambiguous">();

  const prefix = "submodule.";
  for (const entry of config.stdout.split("\0")) {
    if (!entry.startsWith(prefix)) continue;
    const separator = entry.indexOf("\n");
    const key = separator < 0 ? entry : entry.slice(0, separator);
    const dot = key.lastIndexOf(".");
    const name = key.slice(prefix.length, dot);
    const field = key.slice(dot + 1);
    const value = separator < 0 ? "" : entry.slice(separator + 1);
    const selectedName = paths.has(name);
    if (selectedName) {
      const previous = sections.get(name);
      if (field === "path") {
        sections.set(name, value === name && (!previous || previous === "named") ? "matching" : "ambiguous");
      } else if (!previous) sections.set(name, "named");
    }
    if (field === "path" && (!selectedName || value !== name)) {
      const claimed = posix.normalize(value).replace(/\/+$/, "");
      if (claimed !== name && paths.has(claimed)) sections.set(claimed, "ambiguous");
    }
  }
  return sections;
}

function mapping(source: Gitmodules, path: string): Mapping {
  if (typeof source === "string") return source;
  const section = source.get(path);
  return section === "named" ? "ambiguous" : section ?? "absent";
}

function worktreeGitmodules(repoRoot: string, paths: ReadonlySet<string>): Gitmodules {
  try {
    if (!lstatSync(join(repoRoot, ".gitmodules")).isFile()) return "unreadable";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
  }
  return inspectGitmodules(repoRoot, ["--file", ".gitmodules"], paths);
}

function blobGitmodules(repoRoot: string, entry: string | undefined, paths: ReadonlySet<string>): Gitmodules {
  if (entry === undefined) return "absent";
  const match = /^100(?:644|755) (?:blob )?([a-f0-9]+)(?: 0)?$/.exec(entry);
  return match ? inspectGitmodules(repoRoot, ["--blob", match[1]], paths) : "invalid";
}

export function canonicalCheckoutOwned(repoRoot: string, alias: string): boolean {
  const cwd = aliasDir(repoRoot, alias);
  const top = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  const actual = runGit(cwd, ["rev-parse", "--absolute-git-dir"]);
  if (!top.success || !actual.success) return false;
  const expected = runGit(repoRoot, ["rev-parse", "--git-path", `modules/${submodulePath(alias)}`]);
  if (!expected.success) return false;
  try {
    return realpathSync(top.stdout.replace(/\n$/, "")) === realpathSync(cwd)
      && realpathSync(actual.stdout.replace(/\n$/, "")) === realpathSync(resolve(repoRoot, expected.stdout.replace(/\n$/, "")));
  } catch {
    // Missing or foreign Git metadata is not an eligible canonical checkout.
    return false;
  }
}

export function pendingRegistrationGuidance(alias: string): string {
  return `pending registration. Run "oms sync ${alias} --commit" to commit the source registration, then retry.`;
}

const partial = (reason: string): AliasRegistration => ({ kind: "partially registered", reason });
const unknown = (reason: string): AliasRegistration => ({ kind: "indeterminate", reason });

function rootHeadEntries(repoRoot: string, paths: string[]): string | null {
  const head = runGit(repoRoot, ["ls-tree", "-z", "HEAD", "--", ".gitmodules", ...paths]);
  if (head.success) return head.stdout;

  // A missing branch ref is an unborn HEAD; other failed reads are not evidence of absence.
  const symref = runGit(repoRoot, ["symbolic-ref", "--quiet", "HEAD"]);
  const refs = symref.success
    ? runGit(repoRoot, ["for-each-ref", "--count=1", "--format=%(refname)", "--", symref.stdout.trim()])
    : null;
  return refs?.success && !refs.stdout && !refs.stderr ? "" : null;
}

type RegistrationSources = {
  committed: Gitmodules;
  staged: Gitmodules;
  working: Gitmodules;
};

function classifyRegistration(
  repoRoot: string,
  alias: string,
  path: string,
  headGitlink: boolean,
  indexGitlink: boolean,
  sources: RegistrationSources,
): AliasRegistration {
  const committed = mapping(sources.committed, path);
  const staged = mapping(sources.staged, path);
  const working = mapping(sources.working, path);
  for (const [source, registration] of [
    ["HEAD .gitmodules", committed], ["index .gitmodules", staged], ["working tree .gitmodules", working],
  ] as const) {
    if (registration === "unreadable") return unknown(`${source} could not be read`);
    if (registration === "ambiguous") return partial(`${source} has a duplicate or conflicting mapping for ${path}`);
  }

  const initialized = submoduleInitialized(repoRoot, alias);
  if (headGitlink && committed === "matching" && indexGitlink && staged === "matching") {
    // Retain existing handling of malformed baseline metadata for an initialized, committed
    // registration; baseline-aware commands supply their own diagnostics and safety checks.
    if (working === "invalid" && initialized) return { kind: "initialized" };
    if (working === "matching") {
      try {
        if (lstatSync(aliasDir(repoRoot, alias)).isDirectory()) {
          return { kind: initialized ? "initialized" : "registered-uninitialized" };
        }
      } catch {
        // An absent or unreadable working path is not an uninitialized checkout.
      }
    }
  }

  if (!headGitlink && committed === "absent") {
    if (working === "matching" && (indexGitlink ? staged === "matching" : staged === "absent")) {
      if (!initialized) return partial("the working tree registration has no initialized checkout");
      if (!canonicalCheckoutOwned(repoRoot, alias)) {
        return partial("the checkout does not belong to the declared canonical submodule");
      }
      if (!runGit(aliasDir(repoRoot, alias), ["rev-parse", "--verify", "HEAD^{commit}"]).success) {
        return partial("the canonical checkout has no readable HEAD commit");
      }
      return { kind: "pending registration" };
    }
    if (!indexGitlink && staged === "absent" && working === "absent") {
      return initialized ? partial("the checkout exists without a root registration") : { kind: "unregistered" };
    }
  }
  const reason = working === "invalid" ? "working tree .gitmodules has invalid Git config" : "root gitlink and .gitmodules entries do not agree";
  return partial(reason);
}

/** Read root registration afresh for the selected aliases, sharing each source within this call. */
export function aliasRegistrations(repoRoot: string, aliases: readonly string[]): Map<string, AliasRegistration> {
  const registrations = new Map<string, AliasRegistration>();
  if (aliases.length === 0) return registrations;

  const selected = new Map(aliases.map((alias) => [submodulePath(alias), alias]));
  const paths = [...selected.keys()];
  const index = runGit(repoRoot, ["ls-files", "--stage", "-z", "--", ".gitmodules", ...paths]);
  if (!index.success) {
    for (const alias of selected.values()) {
      registrations.set(alias, selected.size > 1
        ? aliasRegistration(repoRoot, alias)
        : unknown("the index .gitmodules sources could not be listed"));
    }
    return registrations;
  }

  let indexMetadata: string | undefined;
  let metadataIssue: "conflict" | "directory" | undefined;
  const indexGitlinks = new Set<string>();
  for (const entry of index.stdout.split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    const fields = entry.slice(0, tab);
    const name = entry.slice(tab + 1);
    const conflicted = !fields.endsWith(" 0");
    if (name === ".gitmodules" || name.startsWith(".gitmodules/")) {
      if (conflicted) metadataIssue = "conflict";
      else if (name === ".gitmodules") indexMetadata = fields;
      else metadataIssue = "directory";
      if (metadataIssue) break;
      continue;
    }

    // ls-files also returns descendants when the selected path is a regular directory.
    const slash = name.indexOf("/", name.indexOf("/") + 1);
    const path = slash < 0 ? name : name.slice(0, slash);
    const alias = selected.get(path);
    if (alias === undefined || registrations.has(alias)) continue;
    if (conflicted) registrations.set(alias, partial("the root gitlink or .gitmodules is conflicted"));
    else if (name !== path || !fields.startsWith("160000 ")) {
      registrations.set(alias, partial(`the root index has an incompatible entry at ${path}`));
    } else indexGitlinks.add(path);
  }
  if (metadataIssue) {
    for (const [path, alias] of selected) {
      const reason = metadataIssue === "conflict"
        ? "the root gitlink or .gitmodules is conflicted"
        : `the root index has an incompatible entry at ${path}`;
      registrations.set(alias, partial(reason));
    }
    return registrations;
  }

  const remaining = paths.filter((path) => !registrations.has(selected.get(path)!));
  if (remaining.length === 0) return registrations;
  const head = rootHeadEntries(repoRoot, remaining);
  if (head === null) {
    for (const path of remaining) {
      const alias = selected.get(path)!;
      registrations.set(alias, remaining.length > 1
        ? aliasRegistration(repoRoot, alias)
        : unknown("the root HEAD registration could not be inspected"));
    }
    return registrations;
  }

  let headMetadata: string | undefined;
  const headGitlinks = new Set<string>();
  for (const entry of head.split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    const fields = entry.slice(0, tab);
    const path = entry.slice(tab + 1);
    if (path === ".gitmodules") headMetadata = fields;
    else if (fields.startsWith("160000 commit ")) headGitlinks.add(path);
    else registrations.set(selected.get(path)!, partial(`the root HEAD has a non-gitlink entry at ${path}`));
  }

  const relevant = new Set(remaining.filter((path) => !registrations.has(selected.get(path)!)));
  if (relevant.size === 0) return registrations;
  const sources: RegistrationSources = {
    committed: blobGitmodules(repoRoot, headMetadata, relevant),
    staged: blobGitmodules(repoRoot, indexMetadata, relevant),
    working: worktreeGitmodules(repoRoot, relevant),
  };
  for (const path of relevant) {
    const alias = selected.get(path)!;
    registrations.set(alias, classifyRegistration(repoRoot, alias, path, headGitlinks.has(path), indexGitlinks.has(path), sources));
  }
  return registrations;
}

export function aliasRegistration(repoRoot: string, alias: string): AliasRegistration {
  return aliasRegistrations(repoRoot, [alias]).get(alias)!;
}
