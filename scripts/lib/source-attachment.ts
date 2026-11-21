import { cancel, log } from "@clack/prompts";
import { redactingGitRunner, runGit, shortOid } from "./git.js";
import { canPrompt, guardedSelect, guardedText, isCancel } from "./prompt-adapter.js";
import { sourceBaseline } from "./source-branch-context.js";
import { inspectIndependentCheckoutIdentity, type ReadySourceCheckout, type SourceWorkspace } from "./source-checkout.js";
import { inspectIndependentSourceHead, sourceOperationBlocker } from "./source-safety.js";
import type { Repo } from "./types.js";

type Attachment = { ok: true; branch: string } | { ok: false; code: number };

/** Check operation markers before attaching detached HEAD, not for an already attached branch. */
export async function resolveSourceBranch(workspace: SourceWorkspace, repo: Repo, checkout: ReadySourceCheckout, command: string): Promise<Attachment> {
  const { alias } = repo;
  const dir = checkout.path;
  const head = inspectIndependentSourceHead(dir, alias);
  if ("reason" in head) { log.error(head.reason); return { ok: false, code: 2 }; }
  if (head.branch !== null) return { ok: true, branch: head.branch };
  const operation = sourceOperationBlocker(dir, alias);
  if (operation) { log.error(operation); return { ok: false, code: 1 }; }

  const refs = runGit(dir, ["for-each-ref", "--sort=refname", "--format=%(refname:lstrip=2)%00%(objectname)%00%(symref)%00%(worktreepath)", "refs/heads/"]);
  if (!refs.success || refs.stderr) { log.error(`${alias}: could not inspect local branches; HEAD was not moved.`); return { ok: false, code: 2 }; }
  const branches = refs.stdout.split("\n").filter(Boolean).map((row) => row.split("\0")).filter(([name, oid, symbolic, worktree]) => name && /^[0-9a-f]{40,64}$/.test(oid) && symbolic === "" && worktree === "");
  const same = branches.find(([, oid]) => oid === head.oid);
  if (same) {
    if (!runGit(dir, ["switch", "--no-guess", "--", same[0]], true, undefined, redactingGitRunner).success) return { ok: false, code: 2 };
    log.info(`${alias}: attached detached HEAD to "${same[0]}" (same commit).`);
    return { ok: true, branch: same[0] };
  }

  const oid = shortOid(dir, head.oid);
  if (!canPrompt()) {
    log.error(`${alias}: detached HEAD at ${oid} has no available local branch at the same commit. Attach with "oms branch switch ${alias} <branch>" before running "oms ${command}".`);
    return { ok: false, code: 1 };
  }

  let identity;
  try { identity = inspectIndependentCheckoutIdentity(workspace, repo, checkout); }
  catch (error) {
    log.error(`${alias}: ${error instanceof Error ? error.message : String(error)}. Retry after checking the source.`);
    return { ok: false, code: 2 };
  }
  const baseline = sourceBaseline(dir, repo);
  const create = "\0create";
  const stop = "\0cancel";
  const choice = await guardedSelect({
    message: `${alias}: HEAD is detached at ${oid}. Choose how to attach before "oms ${command}".`,
    options: [
      { value: create, label: "Create a branch at this commit", hint: "keeps the checked-out commit" },
      ...branches.map(([name, tip]) => ({ value: name, label: `Switch to ${name}`, hint: `moves the checkout to ${tip.slice(0, 12)}${name === baseline ? " (baseline)" : ""}` })),
      { value: stop, label: "Cancel", hint: `leave the checkout detached at ${oid}` },
    ],
  });
  if (isCancel(choice) || choice === stop) { cancel("Cancelled."); return { ok: false, code: 1 }; }
  let branch: string = choice;
  if (choice === create) {
    const name = await guardedText({ message: `${alias}: new branch name`, placeholder: "work/detached" });
    if (isCancel(name)) { cancel("Cancelled."); return { ok: false, code: 1 }; }
    branch = name.trim();
    if (!branch) { log.error(`${alias}: branch name is empty.`); return { ok: false, code: 1 }; }
  }
  try {
    const current = inspectIndependentCheckoutIdentity(workspace, repo, checkout);
    const now = inspectIndependentSourceHead(dir, alias);
    const blocked = sourceOperationBlocker(dir, alias);
    if (blocked) throw new Error(blocked);
    if (current.device !== identity.device || current.inode !== identity.inode || current.gitDevice !== identity.gitDevice || current.gitInode !== identity.gitInode || current.origin !== identity.origin || "reason" in now || now.branch !== null || now.oid !== head.oid) {
      throw new Error("source checkout or detached HEAD changed while waiting for a branch choice");
    }
    if (choice !== create) {
      const tip = runGit(dir, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
      if (!tip.success || tip.stdout.trim() !== branches.find(([name]) => name === branch)?.[1]) throw new Error("selected branch changed while waiting for confirmation");
    }
  } catch (error) {
    log.error(`${alias}: ${error instanceof Error ? error.message : String(error)}. Retry after checking the source.`);
    return { ok: false, code: 2 };
  }
  const args = choice === create ? ["switch", "-c", branch] : ["switch", "--no-guess", "--", branch];
  if (!runGit(dir, args, true, undefined, redactingGitRunner).success) return { ok: false, code: 2 };
  return { ok: true, branch };
}
