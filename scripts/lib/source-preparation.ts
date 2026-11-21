import { cancel, log } from "@clack/prompts";
import { cloneSource } from "./clone-source.js";
import { redactSensitiveUrls } from "./git.js";
import { canPrompt, guardedSelect, isCancel } from "./prompt-adapter.js";
import { inspectSourceCheckout, type ReadySourceCheckout, type SourceCheckout, type SourceWorkspace } from "./source-checkout.js";
import { inferAliasFromCwd } from "./source-workspace.js";
import type { Repo } from "./types.js";

type Unavailable = Exclude<SourceCheckout, ReadySourceCheckout>;
type SourceOutcome = ReadySourceCheckout | { kind: "failed" | "skipped" | "clone-failed" };
type MissingSourcePolicy = "offer-clone" | "offer-skip" | "fail";
type BranchPreparationCommand = "branch list" | "branch switch" | "branch checkout";

function describeUnavailable(repo: Repo, checkout: Unavailable): void {
  log.error(`${repo.alias}: ${checkout.reason}`);
}

export function requireSource(workspace: SourceWorkspace, repo: Repo): ReadySourceCheckout | null {
  const checkout = inspectSourceCheckout(workspace, repo);
  if (checkout.kind === "ready") return checkout;
  describeUnavailable(repo, checkout);
  return null;
}

/** Select a single source before preparation. Destructive commands never infer an alias. */
export async function selectSource(
  workspace: SourceWorkspace,
  repos: Repo[],
  alias: string | undefined,
  command: string,
  policy: "include-missing" | "destructive" | { dirty: (dir: string) => boolean },
): Promise<{ repo: Repo; selection: "direct" | "prompted" } | "noop" | null> {
  const inferred = alias ?? (policy === "destructive" ? null : inferAliasFromCwd(workspace.root, repos));
  if (inferred !== null) {
    const repo = repos.find((candidate) => candidate.alias === inferred);
    if (repo) return { repo, selection: "direct" };
    log.error(`Unknown alias ${JSON.stringify(inferred)}. Use "oms clone --list" to see declared aliases.`);
    return null;
  }

  const interactive = canPrompt();
  const inspected = repos.map((repo) => ({ repo, checkout: inspectSourceCheckout(workspace, repo) }));
  const candidates = inspected.filter(({ checkout }) => checkout.kind === "ready"
    ? (typeof policy !== "object" || policy.dirty(checkout.path))
    : policy === "include-missing" && interactive && checkout.kind === "missing");
  if (candidates.length === 0) {
    if (typeof policy === "object") {
      log.info("Nothing to commit in eligible source checkouts.");
      return "noop";
    }
    for (const { repo, checkout } of inspected) {
      if (checkout.kind !== "ready") describeUnavailable(repo, checkout);
    }
    log.error(`No eligible source checkouts for "oms ${command}".`);
    return null;
  }
  if (candidates.length === 1 && policy !== "destructive") return { repo: candidates[0].repo, selection: "direct" };
  if (!interactive) {
    log.error(`Pass an alias explicitly: "oms ${command} <alias>".`);
    return null;
  }
  const choice = await guardedSelect({
    message: `Select a source repository for "oms ${command}"`,
    options: candidates.map(({ repo, checkout }) => ({ value: repo.alias, label: repo.alias, hint: checkout.kind === "missing" ? "not cloned" : undefined })),
  });
  if (isCancel(choice)) { cancel("Cancelled."); return null; }
  const selected = candidates.find(({ repo }) => repo.alias === choice);
  return selected ? { repo: selected.repo, selection: "prompted" } : null;
}

/** Inspect the complete selection before offering one bounded, write-free decision. */
export async function prepareSources(
  workspace: SourceWorkspace,
  repos: Repo[],
  command: string,
  missingPolicy: MissingSourcePolicy,
): Promise<Map<string, SourceOutcome> | null> {
  const inspected = repos.map((repo) => ({ repo, checkout: inspectSourceCheckout(workspace, repo) }));
  const missing = inspected.filter(({ checkout }) => checkout.kind === "missing");
  let provision: "clone" | "skip" | undefined;
  if (missing.length && missingPolicy !== "fail" && canPrompt()) {
    const clone = { value: "clone" as const, label: "Clone and continue" };
    const skip = { value: "skip" as const, label: "Skip missing checkouts and continue" };
    const stop = { value: "cancel" as const, label: "Cancel without changing any repository" };
    const preferClone = missingPolicy === "offer-clone";
    const choice = await guardedSelect<"clone" | "skip" | "cancel">({
      message: `Missing source checkouts: ${missing.map(({ repo }) => repo.alias).join(", ")}. Choose how to continue with "oms ${command}".`,
      initialValue: preferClone ? "clone" : "skip",
      options: preferClone ? [clone, skip, stop] : [skip, clone, stop],
    });
    if (isCancel(choice) || choice === "cancel") { cancel("Cancelled. No repositories were changed."); return null; }
    provision = choice;
  }

  const outcomes = new Map<string, SourceOutcome>();
  for (const { repo, checkout } of inspected) {
    if (checkout.kind === "ready") {
      outcomes.set(repo.alias, checkout);
    } else if (checkout.kind === "missing" && provision === "skip") {
      log.warn(`${repo.alias}: skipped. ${checkout.reason}`);
      outcomes.set(repo.alias, { kind: "skipped" });
    } else if (checkout.kind === "missing" && provision === "clone") {
      try {
        if (cloneSource(workspace, repo) === "cloned") log.success(`${repo.alias}: cloned`);
        outcomes.set(repo.alias, requireSource(workspace, repo) ?? { kind: "clone-failed" });
      } catch (error) {
        log.error(`${repo.alias}: ${redactSensitiveUrls(error instanceof Error ? error.message : String(error))}`);
        outcomes.set(repo.alias, { kind: "clone-failed" });
      }
    } else {
      describeUnavailable(repo, checkout);
      outcomes.set(repo.alias, { kind: "failed" });
    }
  }
  return outcomes;
}

export async function prepareBranchSource(workspace: SourceWorkspace, repos: Repo[], alias: string | undefined, command: BranchPreparationCommand): Promise<{ repo: Repo; checkout: ReadySourceCheckout } | { code: 1 | 2 }> {
  const selected = await selectSource(workspace, repos, alias, command, "include-missing");
  if (!selected || selected === "noop") return { code: 1 };
  const { repo, selection } = selected;
  const prepared = (await prepareSources(workspace, [repo], command, selection === "direct" ? "offer-clone" : "offer-skip"))?.get(repo.alias);
  return prepared?.kind === "ready" ? { repo, checkout: prepared } : { code: prepared?.kind === "clone-failed" ? 2 : 1 };
}
