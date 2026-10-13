# Proposal

## Why

Merged local branches accumulate after source work is complete, including branches left behind by `oms tree remove`. The existing `oms branch delete` removes only one branch at a time, so users must identify and delete each completed branch separately.

## What Changes

- Add `oms branch clean [alias]` to collect and delete merged local branches in one selected source repository per invocation. Workspace-wide cleanup is out of scope.
- Default to the local branch named by the selected repository's `oms.yaml` `branch`; there is no fixed `main` default. When omitted, use the local branch whose name comes from that repository's existing `origin/HEAD`. Allow `--base <ref>` to select an existing local or remote-tracking comparison branch without changing protected baselines. Do not silently substitute a remote ref or refresh refs after preparation.
- Treat a branch as merged only when its tip commit is reachable from the selected base. Do not infer squash or rebase merges, query pull requests, or treat a missing remote branch as evidence of a merge. A branch with additional commits not included in the base remains intact.
- Display the actual comparison base, deletion candidates, and exclusion reasons before asking for one confirmation of the batch.
- Exclude the current branch, the selected base branch when it is local, every protected baseline, and branches checked out in any worktree. Preserve the existing refusal conditions for ambiguous baseline metadata and in-progress source-repository Git operations.
- Recheck branch tips, merged status, and protection conditions immediately before deletion. Identify confirmed candidates by branch name and commit ID, not creation generation. Preserve candidates that no longer qualify; stop remaining deletions when the base, selected repository declaration or registration, recorded source commit, or shared safety state changes. Never retry with force.
- Delete eligible local branch refs and clean up their branch configuration. Preserve remote refs, worktree contents, and the recorded source commit. Continue after candidate-local failures while shared safety remains valid; report deleted, already-absent, preserved, failed, and not-run outcomes. A config-cleanup failure remains a completed ref deletion with incomplete cleanup. Incomplete batches exit 2 without rollback.
- Shared preparation may initialize registered repositories and create or attach their baseline branch at the recorded commit, including tracking configuration. Those preparation effects remain if deletion is declined.
- In shallow repositories, allow only proven ancestry; preserve unproven branches with a history-limitation reason. Inspection errors stop planning without an implicit fetch.
- Keep the existing single-branch `oms branch delete` workflow unchanged.

Cleanup is interactive and single-repository, without a confirmation bypass or standalone preview mode. Other Git or IDE operations must not change source branches, worktrees, or configuration from confirmation waiting through completion. Expected-commit ref transactions do not atomically protect ref type, worktree occupancy, metadata, or branch configuration.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `ai-submodule-workflow`: Extend local source-repository branch management with confirmed, base-relative batch cleanup while retaining repository boundaries and branch protection rules.

## Impact

- CLI command registration and branch action selection, including built-in help and command documentation.
- Branch deletion safety checks, baseline resolution, local branch inventory, and worktree occupancy checks.
- Behavioral coverage for base-relative merge detection, batch confirmation, protected and occupied branches, concurrent branch changes, and partial deletion failures.
- No new hosting-service integration or dependency is required. After preparation, cleanup does not switch source checkouts or change their files or index. Managed trees are not removed, and root topology and recorded source commits are not changed.
