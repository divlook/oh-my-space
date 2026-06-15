import { spawnSync } from "node:child_process";
import { log } from "@clack/prompts";
import { MANIFEST_FILENAME } from "./constants.js";
import { runtimePlatform, testEnv } from "./env.js";
import { findWorkspaceRoot } from "./git.js";

/** npx skills package identifier for the oms workspace skills (scoped to the repository skills/ directory). */
const SKILLS_REPO = "divlook/oh-my-space/skills";

/** Extra args forwarded to "npx skills add", read from argv so flags pass through verbatim. */
export function skillsForwardedArgs(): string[] {
  // process.argv: [node, oms.js, "skills", ...rest]; drop the "--install" flag and forward the rest.
  return process.argv.slice(3).filter((arg) => arg !== "--install");
}

/** Print the install commands, or with --install delegate to "npx skills add" from the workspace root. */
export async function runSkills(install: boolean, extraArgs: string[]): Promise<number> {
  const projectCommand = `npx skills add ${SKILLS_REPO}`;
  const globalCommand = `${projectCommand} -g`;

  if (!install) {
    log.info("Install the oms workspace skills with the skills tool:");
    log.message(`  ${projectCommand}        # project scope (run at the workspace root)`);
    log.message(`  ${globalCommand}     # global scope (every workspace)`);
    log.message("Add --skill <name> to install one (oms-workspace, oms-pointer, oms-branch), or --list to list them.");
    return 0;
  }

  const wantsGlobal = extraArgs.includes("-g") || extraArgs.includes("--global");
  const workspaceRoot = findWorkspaceRoot();
  if (!workspaceRoot && !wantsGlobal) {
    log.error(
      `"oms skills --install" must run inside an ${MANIFEST_FILENAME} workspace. ` +
        `For a global install from anywhere, run: ${globalCommand}`,
    );
    return 1;
  }

  const args = ["skills", "add", SKILLS_REPO, ...extraArgs];
  const npxBin = testEnv("OMS_NPX_BIN") ?? "npx";
  const result = spawnSync(npxBin, args, {
    stdio: "inherit",
    cwd: workspaceRoot ?? process.cwd(),
    shell: runtimePlatform() === "win32",
  });
  if (result.error || result.status === null) {
    log.error(`Could not run "${[npxBin, ...args].join(" ")}".`);
    log.message(`Install the skills manually: ${projectCommand}`);
    return 1;
  }
  return result.status;
}
