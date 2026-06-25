## Context

`oms sync` currently decides whether to call `git submodule add` by checking whether `.gitmodules` registers `oms/<alias>`. After `oms unsync <alias>` runs without a topology commit, the root repository can be in pending removal topology: root `HEAD` still records the gitlink, while the working tree path and `.gitmodules` entry have been removed or partially removed.

In that state, `syncRepo()` may treat the alias as unregistered and call `git submodule add`, but Git can reject the add because the root index still contains `oms/<alias>` from `HEAD`. The resulting `fatal: 'oms/<alias>' already exists in the index` message is a Git implementation detail, not a useful OMS workflow response.

## Goals / Non-Goals

**Goals:**

- Make `oms sync <alias>` and interactive `oms sync` restore a selected alias that is pending removal from an uncommitted `oms unsync`.
- Avoid invoking `git submodule add` when root `HEAD` already records the selected alias as a submodule.
- Keep topology changes scoped to the selected alias and preserve existing `--commit` and interactive topology prompt behavior.
- Replace low-level index errors with deterministic OMS behavior and clear unsafe-state messages.

**Non-Goals:**

- Do not change the meaning of `oms unsync --commit` or pending removal topology commits.
- Do not automatically resolve merge conflicts or unrelated root index changes.
- Do not restore unrelated `.gitmodules` sections or topology changes for aliases the user did not select.
- Do not introduce a new command for reverting unsync; `oms sync` owns making a selected alias present.

## Decisions

### Decision: Treat pending removal as a restore path in `syncRepo()`

Before the existing unregistered-path `git submodule add` branch, `syncRepo()` should inspect `gitlinkState(repoRoot, alias)`. If root `HEAD` records the gitlink and the alias is in pending or partial removal topology, `syncRepo()` should restore the selected alias instead of adding it as a new submodule.

Alternative considered: fail with a friendly message asking the user to commit or restore manually. This is safer but makes the common "I just unsynced this and want it back" workflow unnecessarily manual.

### Decision: Restore only the selected alias topology

The restore path should avoid broad `git restore .gitmodules` behavior that can discard unrelated edits. It should restore only the selected alias's submodule registration and gitlink state, then initialize the submodule working tree.

The restore path applies only when root `HEAD` records the selected alias as a submodule gitlink and the current topology is missing the selected alias's working tree, the selected alias's `.gitmodules` section, or both. If the selected alias's root gitlink is conflicted, if `oms/<alias>` is occupied by a non-submodule file or non-empty directory, or if root `HEAD` no longer records the selected alias as a submodule gitlink, the state is unsafe rather than a restore target. The restore must preserve unrelated alias topology and unrelated `.gitmodules` edits.

Restoring a plain uncommitted `oms unsync <alias>` means returning the selected alias topology to the state recorded in root `HEAD`; in that common case there is no new add/remove topology left for a topology commit prompt. Existing topology finalization still runs, but it is a no-op when no pending topology remains.

Practical implementation options:

- Restore the selected gitlink path from `HEAD` with a path-limited Git command.
- Restore the selected `.gitmodules` section from `HEAD:.gitmodules` by reading that file and appending only the matching `submodule "oms/<alias>"` section when the working tree does not already contain that alias section.
- After restoring the section, reconcile its `url` and explicit `branch` values from the current manifest. These metadata changes are left as normal unstaged working tree edits rather than being included in topology finalization.
- Run `git submodule update --init -- oms/<alias>` after registration is restored.

When the common restore returns the selected alias topology to the state recorded in root `HEAD`, there is no add/remove topology diff to commit; if `.gitmodules` metadata is then reconciled from `oms.yaml`, that metadata-only diff should remain unstaged and outside topology finalization.

Alternative considered: call `git submodule add --force`. This still treats an existing recorded submodule as a new add and risks fighting Git index state instead of modeling the OMS topology state directly.

### Decision: Preserve topology finalization behavior

After a successful restore, `finalizeTopology()` should remain responsible for prompting or honoring `--commit`. The sync operation should leave the workspace in a coherent synced state first, then rely on the existing topology commit policy.

The selected explicit alias or interactive alias selection is sufficient intent to restore pending removal topology. The restore path should not add a separate confirmation prompt before restoring. A plain restore back to root `HEAD` normally leaves no pending add/remove topology, so the existing topology finalization prompt does not appear unless another pending topology still exists.

Alternative considered: auto-commit the restore. This would violate existing sync/unsync behavior where topology commits are explicit or prompted.

### Decision: Report restore with a message, not a new summary result

The restore path should emit a clear restore-specific message when `oms sync` restores pending removal topology. The command summary should continue using the existing initialized or updated result semantics instead of introducing a new `restored` result.

If restore also updates `.gitmodules` metadata from `oms.yaml`, the restore message should mention that metadata was updated so the user understands any remaining unstaged `.gitmodules` diff.

### Decision: Guard unsafe restore states

The restore path should fail with an OMS-specific message if the selected alias cannot be restored safely, such as when the root gitlink is conflicted or `.gitmodules` cannot be read from `HEAD`. It should not continue to `git submodule add` after detecting a recorded gitlink for the alias.

Unsafe restore states include cases where restoring the selected alias would overwrite a current `.gitmodules` edit for the same alias, replace a non-submodule file or directory at `oms/<alias>`, operate on a conflicted root gitlink, or proceed without recoverable `.gitmodules` data in root `HEAD`.

A pre-existing `oms/<alias>` directory is safe only when it is empty or contains only `.DS_Store`; in the `.DS_Store` case, the file should be removed before restore so the initialized submodule is not left dirty. Root merge/rebase/cherry-pick or similar in-progress operations are unsafe because restore mutates root topology paths. Root detached `HEAD` is not unsafe for a no-commit restore by itself; any commit-specific failure remains the responsibility of existing commit finalization behavior.

Existing staged `.gitmodules` changes do not block restore. The normal topology finalization behavior may unstage `.gitmodules` as a path, so this change preserves file content but does not guarantee preservation of the pre-existing staged state for that file.

## Risks / Trade-offs

- Restoring `.gitmodules` section text incorrectly could disturb unrelated sections or formatting -> limit parsing/writing to the selected section and add regression tests with multiple aliases.
- A partial removal state may include user edits that are not safe to overwrite -> detect conflicted or ambiguous states and fail with guidance instead of forcing a restore.
- Interactive `oms sync` is hard to exercise directly in the current test harness -> cover the shared sync selection path with explicit aliases and keep behavior in `syncRepo()` so interactive and explicit paths share the fix.
- Existing cleanup-on-failed-add behavior may still mutate topology in unrelated failure paths -> ensure the new pending-removal branch runs before `git submodule add`, avoiding cleanup for this case.

## Migration Plan

No user migration is required. Existing workspaces that hit this state can rerun `oms sync <alias>` after the fix to restore the pending removal instead of manually cleaning the root index.

Rollback is the existing behavior: users can still recover manually by committing the removal with `oms unsync <alias> --commit` or using Git restore commands to undo the pending removal.

## Open Questions

- None.
