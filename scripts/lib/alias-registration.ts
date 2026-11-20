import { lstatSync, realpathSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { aliasDir, runGit, submoduleInitialized, submodulePath } from "./git.js";

export type AliasRegistration =
  | { kind: "initialized" | "registered-uninitialized" | "pending registration" | "unregistered" }
  | { kind: "partially registered" | "indeterminate"; reason: string };

type Mapping = "absent" | "matching" | "ambiguous" | "invalid" | "unreadable";

function inspectMapping(repoRoot: string, path: string, source: string[]): Mapping {
  const config = runGit(repoRoot, ["config", ...source, "--null", "--list"]);
  if (!config.success) {
    return config.exitCode === 3 || /bad config line/i.test(config.stderr) ? "invalid" : "unreadable";
  }

  const prefix = `submodule.${path}.`;
  const pathKey = `${prefix}path`;
  let named = false;
  let matched = false;
  for (const entry of config.stdout.split("\0")) {
    const separator = entry.indexOf("\n");
    const key = separator < 0 ? entry : entry.slice(0, separator);
    if (key.startsWith(prefix) && !key.slice(prefix.length).includes(".")) named = true;
    if (!key.startsWith("submodule.") || !key.endsWith(".path")) continue;
    const value = separator < 0 ? "" : entry.slice(separator + 1);
    if (key === pathKey) {
      if (value !== path || matched) return "ambiguous";
      matched = true;
    } else if (posix.normalize(value).replace(/\/+$/, "") === path) {
      return "ambiguous";
    }
  }
  return matched ? "matching" : named ? "ambiguous" : "absent";
}

function worktreeMapping(repoRoot: string, path: string): Mapping {
  try {
    if (!lstatSync(join(repoRoot, ".gitmodules")).isFile()) return "unreadable";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
  }
  return inspectMapping(repoRoot, path, ["--file", ".gitmodules"]);
}

function gitmodulesBlob(repoRoot: string, path: string, entry: string | undefined): Mapping {
  if (entry === undefined) return "absent";
  const match = /^100(?:644|755) (?:blob )?([a-f0-9]+)(?: 0)?$/.exec(entry);
  return match ? inspectMapping(repoRoot, path, ["--blob", match[1]]) : "invalid";
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

export function aliasRegistration(repoRoot: string, alias: string): AliasRegistration {
  const path = submodulePath(alias);
  const partial = (reason: string): AliasRegistration => ({ kind: "partially registered", reason });
  const unknown = (reason: string): AliasRegistration => ({ kind: "indeterminate", reason });
  const index = runGit(repoRoot, ["ls-files", "--stage", "-z", "--", ".gitmodules", path]);
  if (!index.success) return unknown("the index .gitmodules sources could not be listed");

  let indexMetadata: string | undefined;
  let indexGitlink = false;
  for (const entry of index.stdout.split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    const fields = entry.slice(0, tab);
    const name = entry.slice(tab + 1);
    if (!fields.endsWith(" 0")) return partial("the root gitlink or .gitmodules is conflicted");
    if (name === ".gitmodules") indexMetadata = fields;
    else if (name !== path || !fields.startsWith("160000 ")) {
      return partial(`the root index has an incompatible entry at ${path}`);
    } else indexGitlink = true;
  }

  const head = runGit(repoRoot, ["ls-tree", "-z", "HEAD", "--", ".gitmodules", path]);
  if (!head.success) {
    // A missing branch ref is an unborn HEAD; other failed reads are not evidence of absence.
    const symref = runGit(repoRoot, ["symbolic-ref", "--quiet", "HEAD"]);
    const refs = symref.success
      ? runGit(repoRoot, ["for-each-ref", "--count=1", "--format=%(refname)", "--", symref.stdout.trim()])
      : null;
    if (!refs?.success || refs.stdout || refs.stderr) return unknown("the root HEAD registration could not be inspected");
  }

  let headMetadata: string | undefined;
  let headGitlink = false;
  for (const entry of head.success ? head.stdout.split("\0") : []) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    const fields = entry.slice(0, tab);
    if (entry.slice(tab + 1) === ".gitmodules") headMetadata = fields;
    else if (fields.startsWith("160000 commit ")) headGitlink = true;
    else return partial(`the root HEAD has a non-gitlink entry at ${path}`);
  }

  const committed = gitmodulesBlob(repoRoot, path, headMetadata);
  const staged = gitmodulesBlob(repoRoot, path, indexMetadata);
  const working = worktreeMapping(repoRoot, path);
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
