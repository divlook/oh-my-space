import { isAbsolute, relative, resolve, sep } from "node:path";
import { log } from "@clack/prompts";
import { DATA_DIRNAME } from "./constants.js";
import { loadRepos } from "./manifest.js";
import { openSourceWorkspace, type SourceWorkspace } from "./source-checkout.js";
import type { Repo, WorkspaceOptions } from "./types.js";

export function loadForSources(options: WorkspaceOptions = {}, git?: SourceWorkspace["git"]): { workspace: SourceWorkspace; repoRoot: string; repos: Repo[] } | null {
  const loaded = loadRepos(options);
  if (!loaded) return null;
  try {
    const workspace = openSourceWorkspace(loaded.repoRoot, git);
    return { workspace, repoRoot: workspace.root, repos: loaded.repos };
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** Path context is independent of whether the source checkout has been provisioned. */
export function inferAliasFromCwd(repoRoot: string, repos: readonly Repo[], cwd = process.cwd()): string | null {
  const path = relative(repoRoot, resolve(cwd));
  if (isAbsolute(path)) return null;
  const [namespace, alias] = path.split(sep, 2);
  return namespace === DATA_DIRNAME && repos.some((repo) => repo.alias === alias) ? alias : null;
}
