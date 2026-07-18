import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { MANIFEST_FILENAME } from "./constants.js";
import { inspectGitVersion, inspectWorkspaceGitIdentity } from "./git.js";
import { ensureOmsNotIgnored } from "./workspace-ignore.js";
import type { WorkspaceMode } from "./types.js";
import { withWorkspaceMutation } from "./workspace-mutation.js";

const INIT_TEMPLATE = `# yaml-language-server: $schema=https://raw.githubusercontent.com/divlook/oh-my-space/main/oms.schema.json
repos:
  - alias: example
    remotes:
      origin: git@github.com:example/repo.git
      # upstream: git@github.com:upstream/repo.git
    branch: main
`;

const WORKTREE_INIT_TEMPLATE = `# yaml-language-server: $schema=https://raw.githubusercontent.com/divlook/oh-my-space/main/oms.schema.json
mode: worktree
repos:
  - alias: example
    remotes:
      origin: git@github.com:example/repo.git
      # upstream: git@github.com:upstream/repo.git
    branch: main
`;

/** Creates a basic oms.yaml template in the current directory. */
export async function runInit(options: { force?: boolean; mode?: string }): Promise<number> {
  const cwd = process.cwd();
  const target = join(cwd, MANIFEST_FILENAME);
  const mode: WorkspaceMode = options.mode === undefined ? "submodule" : options.mode as WorkspaceMode;
  if (mode !== "submodule" && mode !== "worktree") {
    log.error(`Invalid mode "${options.mode}"; expected "submodule" or "worktree".`);
    return 1;
  }
  const gitVersion = inspectGitVersion();
  if (!gitVersion.ok) {
    log.error(gitVersion.reason);
    return 1;
  }
  const identity = inspectWorkspaceGitIdentity(cwd);
  if (mode === "submodule" && identity.kind === "mismatch") {
    log.error(
      `Cannot initialize a workspace at ${cwd} because it is below the root Git top-level ${identity.gitTopLevel}. ` +
        `Run "oms init" at ${identity.gitTopLevel}, or initialize a separate Git repository at ${cwd}.`,
    );
    return 1;
  }
  if (identity.kind === "indeterminate") {
    log.error(
      `Could not verify the workspace target ${cwd}: ${identity.reason}. ` +
        "No files were changed; retry after the path and Git repository are accessible.",
    );
    return 1;
  }
  if (existsSync(target) && !options.force) {
    log.error(`${MANIFEST_FILENAME} already exists at ${target}. Use --force to overwrite.`);
    return 1;
  }
  return withWorkspaceMutation("init", async () => {
    writeFileSync(target, mode === "worktree" ? WORKTREE_INIT_TEMPLATE : INIT_TEMPLATE);
    log.success(`created ${MANIFEST_FILENAME} at ${target}`);
    if (mode === "submodule") ensureOmsNotIgnored(cwd);
    if (mode === "submodule" && identity.kind === "no-work-tree") {
      log.info(`oms manages sources as git submodules; run "git init" here if this is not a git repo yet.`);
    }
    log.info(
      mode === "worktree"
        ? `edit alias/remotes/branch, then run "oms sync" to create local worktrees.`
        : `edit alias/remotes/branch, then run "oms sync".`,
    );
    log.info("Optional — set up AI agent guidance for this workspace:");
    log.message(`  oms agent install   # add the OMS instruction block for AI agents`);
    log.message(`  oms skills          # show how to install the oms workspace skills`);
    return 0;
  }, { workspaceRoot: cwd, bootstrapIdentity: false });
}
