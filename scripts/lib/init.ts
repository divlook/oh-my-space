import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { MANIFEST_FILENAME } from "./constants.js";
import { isGitRepo } from "./git.js";
import { ensureOmsNotIgnored } from "./workspace-ignore.js";

const INIT_TEMPLATE = `# yaml-language-server: $schema=https://raw.githubusercontent.com/divlook/oh-my-space/main/oms.schema.json
repos:
  - alias: example
    remotes:
      origin: git@github.com:example/repo.git
      # upstream: git@github.com:upstream/repo.git
    branch: main
`;

/** Creates a basic oms.yaml template in the current directory. */
export async function runInit(options: { force?: boolean }): Promise<number> {
  const target = join(process.cwd(), MANIFEST_FILENAME);
  if (existsSync(target) && !options.force) {
    log.error(`${MANIFEST_FILENAME} already exists at ${target}. Use --force to overwrite.`);
    return 1;
  }
  writeFileSync(target, INIT_TEMPLATE);
  log.success(`created ${MANIFEST_FILENAME} at ${target}`);
  // Sources are tracked submodules, so make sure no stale oms version left oms/ ignored.
  ensureOmsNotIgnored(process.cwd());
  if (!isGitRepo(process.cwd())) {
    log.info(`oms manages sources as git submodules; run "git init" here if this is not a git repo yet.`);
  }
  log.info(`edit alias/remotes/branch, then run "oms sync".`);
  // Signpost the optional AI-setup commands; output-only, installs nothing.
  log.info("Optional — set up AI agent guidance for this workspace:");
  log.message(`  oms agent install   # add the OMS instruction block for AI agents`);
  log.message(`  oms skills          # show how to install the oms workspace skills`);
  return 0;
}
