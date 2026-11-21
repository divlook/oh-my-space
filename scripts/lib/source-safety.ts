import { runGit } from "./git.js";
import { inspectSourceOperations } from "./git-operation-state.js";

export function sourceOperationBlocker(dir: string, alias: string, probe?: Parameters<typeof inspectSourceOperations>[1]): string | null {
  const operation = inspectSourceOperations(dir, probe);
  if (operation.kind === "active") return `${alias}: a ${operation.label} is in progress inside oms/${alias}. Resolve, continue, or abort it first.`;
  if (operation.kind === "unreadable") return operation.access
    ? `${alias}: cannot inspect source operation marker ${operation.marker}; resolve filesystem access, then retry.`
    : `${alias}: cannot inspect source operation marker ${operation.marker}; retry once Git is idle.`;
  return null;
}

export function inspectIndependentSourceHead(dir: string, alias: string): { branch: string | null; oid: string } | { reason: string } {
  const head = runGit(dir, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const oid = head.stdout.trim();
  if (!head.success || head.stderr.trim() || !/^[0-9a-f]{40,64}$/.test(oid)) return { reason: `${alias}: cannot inspect source HEAD; retry once Git is idle.` };
  const branch = runGit(dir, ["symbolic-ref", "--quiet", "HEAD"]);
  const ref = branch.stdout.replace(/\r?\n$/, "");
  const prefix = "refs/heads/";
  const name = ref.startsWith(prefix) ? ref.slice(prefix.length) : "";
  if (branch.stderr.trim() || (!branch.success && branch.exitCode !== 1) || (branch.success && !name)) {
    return { reason: `${alias}: cannot inspect whether source HEAD is detached; retry once Git is idle.` };
  }
  return { branch: branch.success ? name : null, oid };
}

export function requireAttachedSource(dir: string, alias: string, probe?: Parameters<typeof inspectSourceOperations>[1]): { branch: string } | { reason: string } {
  const operation = sourceOperationBlocker(dir, alias, probe);
  if (operation) return { reason: operation };
  const head = inspectIndependentSourceHead(dir, alias);
  if ("reason" in head) return head;
  if (head.branch === null) return { reason: `${alias}: source HEAD is detached. Attach it with "oms branch switch ${alias} <branch>" first.` };
  return { branch: head.branch };
}
