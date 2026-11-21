import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ALIAS_PATTERN, DATA_DIRNAME, MANIFEST_FILENAME } from "./constants.js";
import { parseManifest } from "./manifest.js";
import { inspectSourceCheckout, type SourceCheckout, type SourceWorkspace } from "./source-checkout.js";
import type { Repo } from "./types.js";

type SourceSelection =
  | { kind: "current" | "former"; repo: Repo; checkout: SourceCheckout }
  | { kind: "unidentified"; reason: string };

function historicalRepos({ root, git }: SourceWorkspace, oid: string): Repo[] {
  const entry = git(root, ["ls-tree", "-z", oid, "--", MANIFEST_FILENAME]);
  if (!entry.success) throw new Error("could not read the historical root tree");
  if (!entry.stdout) return [];
  const match = /^100(?:644|755) blob ([a-f0-9]+)\t/.exec(entry.stdout);
  if (!match) throw new Error("a historical manifest is not a regular file");
  const blob = git(root, ["cat-file", "blob", match[1]]);
  if (!blob.success) throw new Error("could not read the historical manifest");
  try {
    return parseManifest(blob.stdout, true).repos;
  } catch {
    throw new Error("a historical manifest is invalid or ambiguous");
  }
}

function formerDeclaration(workspace: SourceWorkspace, alias: string): Repo | undefined {
  const { git, root } = workspace;
  const shallow = git(root, ["rev-parse", "--is-shallow-repository"]);
  if (!shallow.success || shallow.stdout.trim() !== "false") {
    throw new Error("root history is incomplete; retrieve full history before verifying a former source");
  }
  const head = git(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!head.success) throw new Error("root HEAD is unavailable; no former declaration can be verified");
  const tip = head.stdout.trim();
  const find = (oid: string) => historicalRepos(workspace, oid).find((repo) => repo.alias === alias);
  if (find(tip)) throw new Error("the declaration is still present in root HEAD; commit its removal first");
  const revisions = git(root, ["log", "--first-parent", "--full-history", "--format=%H %P", tip, "--", MANIFEST_FILENAME]);
  if (!revisions.success) throw new Error("could not inspect root manifest history");
  for (const line of revisions.stdout.trimEnd().split("\n")) {
    if (!line) continue;
    const [commit, ...parents] = line.trimEnd().split(" ");
    if (!parents.length) continue;
    if (find(commit)) throw new Error("the removal boundary in root history could not be verified");
    const prior = find(parents[0]);
    for (const parent of parents.slice(1)) {
      const other = find(parent);
      // Only origin identity matters; branch and additional remotes may vary.
      if (other?.remotes.origin !== prior?.remotes.origin) {
        throw new Error("merge parents disagree about the former declaration");
      }
    }
    if (prior) return prior;
  }
  return undefined;
}

export function resolveSourceSelection(workspace: SourceWorkspace, current: readonly Repo[], alias: string): SourceSelection {
  const repo = current.find((item) => item.alias === alias);
  if (repo) return { kind: "current", repo, checkout: inspectSourceCheckout(workspace, repo) };
  if (!ALIAS_PATTERN.test(alias)) return { kind: "unidentified", reason: "invalid source alias" };
  try {
    const former = formerDeclaration(workspace, alias);
    if (!former) return { kind: "unidentified", reason: "no former declaration can be verified in root HEAD history" };
    const checkout = inspectSourceCheckout(workspace, former);
    if (checkout.kind !== "ready") return { kind: "unidentified", reason: checkout.reason };
    return { kind: "former", repo: former, checkout };
  } catch (error) {
    return { kind: "unidentified", reason: error instanceof Error ? error.message : String(error) };
  }
}

export function undeclaredSourcePaths(workspace: SourceWorkspace, current: readonly Repo[]): string[] {
  const path = join(workspace.root, DATA_DIRNAME);
  let entry;
  try {
    entry = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (!entry.isDirectory() || realpathSync(path) !== path) throw new Error(`${path} is not a canonical directory`);
  const declared = new Set(current.map(({ alias }) => alias));
  return readdirSync(path, { withFileTypes: true })
    .filter((child) => !declared.has(child.name) && (child.isDirectory() || child.isSymbolicLink()))
    .map((child) => child.name)
    .sort();
}
