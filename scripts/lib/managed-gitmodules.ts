import { runGit, submodulePath } from "./git.js";
import type { AliasMetadataPlan } from "./gitmodules-reconcile.js";

export function transformManagedGitmodules(
  repoRoot: string,
  file: string,
  plans: AliasMetadataPlan[],
  options: { writePaths: boolean; removeAliases: string[] },
): boolean {
  for (const plan of plans) {
    const path = submodulePath(plan.alias);
    const key = `submodule.${path}`;
    if (options.writePaths && !runGit(repoRoot, ["config", "--file", file, `${key}.path`, path]).success) return false;
    if (!runGit(repoRoot, ["config", "--file", file, `${key}.url`, plan.url]).success) return false;
    if (plan.branch !== null) {
      if (!runGit(repoRoot, ["config", "--file", file, `${key}.branch`, plan.branch]).success) return false;
    } else if (runGit(repoRoot, ["config", "--file", file, "--get", `${key}.branch`]).success) {
      if (!runGit(repoRoot, ["config", "--file", file, "--unset", `${key}.branch`]).success) return false;
    }
  }
  for (const alias of options.removeAliases) {
    const removed = runGit(repoRoot, ["config", "--file", file, "--remove-section", `submodule.${submodulePath(alias)}`]);
    if (!removed.success && removed.exitCode !== 5) return false;
  }
  return true;
}
