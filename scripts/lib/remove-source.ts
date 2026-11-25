import { isDeepStrictEqual } from "node:util";
import { realpathSync, rmSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { log } from "@clack/prompts";
import { resolveSourceSelection, undeclaredSourcePaths } from "./former-source.js";
import { redactSensitiveUrls } from "./git.js";
import { loadRepos } from "./manifest.js";
import { canPrompt, guardedConfirm } from "./prompt-adapter.js";
import { describeRemovalRefs } from "./removal-history.js";
import { authorizeInaccessibleOrigin, inspectRemovalSafety, type RemovalSafety } from "./removal-safety.js";
import { openSourceWorkspace, type SourceCheckout, type SourceWorkspace } from "./source-checkout.js";
import type { Repo } from "./types.js";

type RemovalTarget = {
  repo: Repo;
  checkout: Extract<SourceCheckout, { kind: "ready" }>;
  former: boolean;
};

type RemovalSelection = {
  targets: RemovalTarget[];
  absent: string[];
  unidentified: { alias: string; reason: string }[];
  blockers: { alias: string; reason: string }[];
};

function planRemovalSelection(workspace: SourceWorkspace, current: readonly Repo[], aliases: readonly string[], all: boolean): RemovalSelection {
  if (!all && aliases.length === 0) throw new Error("Pass explicit aliases to oms remove or use oms remove --all.");
  const names = all ? [...current.map(({ alias }) => alias), ...undeclaredSourcePaths(workspace, current)] : new Set(aliases);
  const plan: RemovalSelection = { targets: [], absent: [], unidentified: [], blockers: [] };
  for (const alias of names) {
    const result = resolveSourceSelection(workspace, current, alias);
    if (result.kind === "unidentified") {
      (all ? plan.unidentified : plan.blockers).push({ alias, reason: result.reason });
    } else if (result.checkout.kind === "missing") {
      plan.absent.push(alias);
    } else if (result.checkout.kind === "ready") {
      plan.targets.push({ repo: result.repo, checkout: result.checkout, former: result.kind === "former" });
    } else {
      plan.blockers.push({ alias, reason: result.checkout.reason });
    }
  }
  return plan;
}

async function authorizeRemoval(count: number, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!canPrompt()) {
    log.error("No checkout was removed. Review the plan and pass --yes to approve removal without a terminal.");
    return false;
  }
  const approved = await guardedConfirm({ message: `Remove ${count} local checkout${count === 1 ? "" : "s"}?`, initialValue: false });
  if (approved !== true) log.info("No checkout was removed.");
  return approved === true;
}

type RemoveOptions = { all?: boolean; yes?: boolean; force?: boolean };

export async function runRemove(aliases: string[], options: RemoveOptions, git?: SourceWorkspace["git"]): Promise<number> {
  const loaded = loadRepos();
  if (!loaded) return 1;
  const { all = false, yes = false, force = false } = options;
  let workspace: SourceWorkspace;
  let selection: RemovalSelection;
  try {
    workspace = openSourceWorkspace(loaded.repoRoot, git);
    selection = planRemovalSelection(workspace, loaded.repos, aliases, all);
  } catch (error) {
    log.error(redactSensitiveUrls(String(error)));
    return 1;
  }
  for (const alias of selection.absent) log.info(`${alias}: already absent`);
  for (const { alias, reason } of selection.unidentified) log.info(`${alias}: unidentified; preserved (${reason})`);

  const planned: { target: RemovalTarget; safety: RemovalSafety }[] = [];
  const cwd = realpathSync(process.cwd());
  for (const target of selection.targets) {
    const { alias } = target.repo;
    try {
      const here = relative(target.checkout.path, cwd);
      if (here === "" || (!isAbsolute(here) && here.split(/[\\/]/, 1)[0] !== "..")) {
        throw new Error("run removal from outside the selected checkout");
      }
      const safety = inspectRemovalSafety(workspace, alias, target.checkout, force);
      planned.push({ target, safety });
      log.info(`${alias} (${target.former ? "former declaration" : "current declaration"}): ${target.checkout.path}; ${describeRemovalRefs(safety.history)}${safety.working ? "; working files will be discarded" : ""}`);
    } catch (error) {
      selection.blockers.push({ alias, reason: redactSensitiveUrls(error instanceof Error ? error.message : String(error)) });
    }
  }
  for (const { alias, reason } of selection.blockers) log.error(`${alias}: ${reason}`);
  if (selection.blockers.length) {
    log.error("The selection was blocked. No checkout was removed.");
    return 2;
  }
  if (!planned.length) return 0;
  const inaccessible = planned.find(({ safety }) => safety.proof.kind === "inaccessible");
  if (inaccessible && !await authorizeInaccessibleOrigin(inaccessible.target.repo.alias, !all && aliases.length === 1)) return 2;
  if (!await authorizeRemoval(planned.length, yes)) return 1;

  const completed: string[] = [];
  for (const [index, { target, safety }] of planned.entries()) {
    const { alias } = target.repo;
    try {
      const latest = loadRepos({ cwd: workspace.root });
      if (!latest || realpathSync(latest.repoRoot) !== workspace.root) throw new Error("workspace declaration is unavailable");
      const now = resolveSourceSelection(workspace, latest.repos, alias);
      if (now.kind === "unidentified" || now.checkout.kind !== "ready" ||
          !isDeepStrictEqual(now.repo, target.repo) || (now.kind === "former") !== target.former ||
          !isDeepStrictEqual(now.checkout, target.checkout) ||
          !isDeepStrictEqual(inspectRemovalSafety(workspace, alias, now.checkout, force), safety)) {
        throw new Error("checkout changed since approval; review a new removal plan");
      }
    } catch (error) {
      log.error(`${alias}: ${redactSensitiveUrls(String(error))}`);
      log.info(`Removed: ${completed.join(", ") || "none"}; not attempted: ${planned.slice(index).map(({ target }) => target.repo.alias).join(", ")}.`);
      return 2;
    }
    try {
      rmSync(target.checkout.path, { recursive: true, force: false });
      completed.push(alias);
      log.success(`${alias}: removed local checkout`);
    } catch (error) {
      log.error(`${alias}: deletion did not complete; inspect ${target.checkout.path}. ${redactSensitiveUrls(String(error))}`);
      log.info(`Removed: ${completed.join(", ") || "none"}; not attempted: ${planned.slice(index + 1).map(({ target }) => target.repo.alias).join(", ") || "none"}.`);
      return 2;
    }
  }
  return 0;
}
