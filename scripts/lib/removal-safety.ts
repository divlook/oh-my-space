import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readdirSync, readlinkSync, readSync } from "node:fs";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { TREE_DIRNAME } from "./constants.js";
import { inspectSourceOperations } from "./git-operation-state.js";
import { canPrompt, guardedText } from "./prompt-adapter.js";
import { readRemovalHistory, verifyOriginHistory, type OriginProof, type RemovalHistory } from "./removal-history.js";
import type { SourceCheckout, SourceWorkspace } from "./source-checkout.js";

type ReadyCheckout = Extract<SourceCheckout, { kind: "ready" }>;

export type RemovalSafety = { working: string; files: string; history: RemovalHistory; proof: OriginProof };

function fingerprintWorkingFiles(checkout: string, status: string, index: string): string {
  const hash = createHash("sha256").update(index).update("\0").update(status);
  const paths = status.split("\0");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  function add(path: string): void {
    if (path.split(/[\\/]/).includes(".git")) throw new Error(`nested Git data at ${path}; preserve it separately before removal`);
    hash.update(path).update("\0");
    const file = join(checkout, path);
    let info;
    try { info = lstatSync(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update("absent\0");
      return;
    }
    hash.update(`${info.mode}:${info.size}:${info.mtimeMs}\0`);
    if (info.isDirectory()) {
      for (const child of readdirSync(file).sort()) add(join(path, child));
    } else if (info.isSymbolicLink()) {
      hash.update(readlinkSync(file)).update("\0");
    } else if (info.isFile()) {
      const fd = openSync(file, "r");
      try {
        for (;;) {
          const size = readSync(fd, buffer);
          if (!size) break;
          hash.update(buffer.subarray(0, size));
        }
      } finally {
        closeSync(fd);
      }
    } else {
      throw new Error(`cannot safely inspect special file ${path}`);
    }
  }
  for (let i = 0; i < paths.length - 1; i++) {
    const entry = paths[i];
    add(entry.slice(3).replace(/\/$/, ""));
    if (/^[RC]|^.[RC]/.test(entry)) add(paths[++i]);
  }
  return hash.digest("hex");
}

function optionalDirectory(path: string): boolean {
  try {
    if (!lstatSync(path).isDirectory()) throw new Error(`${path} is not a canonical directory`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function inspectRemovalSafety(workspace: SourceWorkspace, alias: string, checkout: ReadyCheckout, force: boolean): RemovalSafety {
  const { git, root } = workspace;
  const { path, origin } = checkout;
  const trees = join(root, TREE_DIRNAME);
  const aliasTrees = join(trees, alias);
  if (optionalDirectory(trees) && optionalDirectory(aliasTrees)) {
    const tasks = readdirSync(aliasTrees);
    if (tasks.length) throw new Error(`managed tree ${join(TREE_DIRNAME, alias, tasks[0])} exists; inspect it with oms tree list and resolve it with oms tree remove`);
  }
  const worktrees = git(path, ["worktree", "list", "--porcelain", "-z"]);
  const paths = worktrees.stdout.split("\0").filter((field) => field.startsWith("worktree ")).map((entry) => entry.slice(9));
  if (!worktrees.success || worktrees.stderr.trim() || paths[0] !== path) throw new Error("could not verify all linked worktrees");
  if (paths.length > 1) throw new Error(`linked worktree ${paths[1]} exists; preserve and remove it with git worktree remove before retrying`);
  const operation = inspectSourceOperations(path);
  if (operation.kind === "active") throw new Error(`${operation.label} is in progress; finish or abort it before removing the checkout`);
  if (operation.kind === "unreadable") throw new Error(`could not inspect ${operation.marker}`);
  const history = readRemovalHistory(git, path);
  if (history.refs.some(({ name }) => name === "refs/stash")) throw new Error("stash exists; preserve it outside the checkout before retrying");
  const entries = git(path, ["ls-files", "-v", "-z"]);
  if (!entries.success || entries.stderr.trim() || /(?:^|\0)[a-zS] /.test(entries.stdout)) {
    throw new Error("cannot verify files marked assume-unchanged or skip-worktree; restore normal Git file inspection before retrying");
  }
  try {
    lstatSync(join(checkout.gitDir, "modules"));
    throw new Error("retained nested submodule Git data exists; preserve it separately before removal");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const working = git(path, ["--no-optional-locks", "-c", "status.renames=false", "status", "--porcelain=v1", "-z", "--ignore-submodules=none", "--untracked-files=all", "--ignored"]);
  if (!working.success || working.stderr.trim()) throw new Error("could not inspect staged, unstaged, untracked, and ignored files");
  if (working.stdout && !force) throw new Error("checkout has staged, unstaged, untracked, or ignored files. Preserve them or explicitly pass --force to discard working files");
  const index = working.stdout ? git(path, ["ls-files", "--stage", "-z"]) : null;
  if (index && (!index.success || index.stderr.trim())) throw new Error("could not inspect staged contents");
  const files = index ? fingerprintWorkingFiles(path, working.stdout, index.stdout) : "";
  const proof = verifyOriginHistory(git, path, origin, history);
  if (proof.kind === "inaccessible") {
    if (history.reflogOnly.length) throw new Error(`reflog-only commit ${history.reflogOnly[0]} cannot be verified without origin; preserve it outside the checkout before retrying`);
    for (const { name, oid, remote, upstream } of history.refs) {
      if (!name.startsWith("refs/heads/") || remote !== "origin") continue;
      if (!upstream.startsWith("refs/")) throw new Error(`${name} has an origin upstream that could not be verified`);
      const ancestor = git(path, ["--no-replace-objects", "merge-base", "--is-ancestor", oid, upstream]);
      if (!ancestor.success || ancestor.stderr.trim()) throw new Error(`${name} is ahead of, diverged from, or cannot be compared with its last known origin upstream; preserve it before retrying`);
    }
    const attached = git(path, ["symbolic-ref", "--quiet", "HEAD"]);
    if (!attached.success) {
      if (attached.exitCode !== 1 || attached.stderr.trim()) throw new Error("could not determine whether HEAD is detached");
      const known = history.refs.some(({ name, oid }) => name.startsWith("refs/remotes/origin/") &&
        git(path, ["--no-replace-objects", "merge-base", "--is-ancestor", history.head, oid]).success);
      if (!known) throw new Error(`detached HEAD ${history.head} cannot be recovered from any last known origin branch; preserve it before retrying`);
    }
  }
  return { working: working.stdout, files, history, proof };
}

export async function authorizeInaccessibleOrigin(alias: string, singleExplicit: boolean): Promise<boolean> {
  if (!singleExplicit || !canPrompt()) {
    log.error(`${alias}: origin is inaccessible. No checkout was removed. Only a single explicitly named checkout in a terminal can use the typed-alias exception.`);
    return false;
  }
  log.warn(`${alias}: origin is inaccessible. This checkout may be the only remaining copy.`);
  const typed = await guardedText({ message: `Type the exact alias ${alias} to allow removal without current origin proof.` });
  if (typed !== alias) log.info("Alias did not match. No checkout was removed.");
  return typed === alias;
}
