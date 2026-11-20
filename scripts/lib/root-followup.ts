import { log } from "@clack/prompts";
import { gitlinkState, rootFollowupAction } from "./workspace-state.js";

export function printRootFollowups(repoRoot: string, aliases: readonly string[]): void {
  let moved = 0;
  let firstMoved: string | undefined;
  const pending: string[] = [];
  for (const alias of aliases) {
    const action = rootFollowupAction(gitlinkState(repoRoot, alias));
    if (action === "record") {
      moved++;
      firstMoved ??= alias;
    } else if (action === "sync") {
      pending.push(alias);
    }
  }

  if (moved === 1) {
    log.info(`Run "oms record ${firstMoved}" to record the root pointer update.`);
  } else if (moved > 1) {
    log.info(`Run "oms record --all" to record ${moved} root pointer updates.`);
  }
  for (const alias of pending) log.info(`Run "oms sync ${alias} --commit" to create the topology commit.`);
}
