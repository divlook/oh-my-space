## 1. Reproduce and Guard Behavior

- [x] 1.1 Add a regression test for `oms sync api`, `oms unsync api` without committing, then `oms sync api` restoring without `already exists in the index`.
- [x] 1.2 Add coverage for a multi-alias manifest where only the selected pending-removal alias is restored and unrelated aliases are not modified.
- [x] 1.3 Add coverage for an unsafe pending-removal state, such as a conflicted root gitlink, failing before `git submodule add` with an OMS-specific message.
- [x] 1.4 Add coverage for an `oms/<alias>` directory containing only `.DS_Store`, verifying restore removes it and does not leave the submodule dirty.
- [x] 1.5 Add representative partial-removal coverage where only the selected `.gitmodules` section or only the selected working tree path is missing while root `HEAD` still records the alias gitlink.
- [x] 1.6 Add representative unsafe coverage for same-alias `.gitmodules` overwrite risk or a non-submodule path occupying `oms/<alias>`.
- [x] 1.7 Add representative unsafe coverage for root merge, rebase, cherry-pick, or similar operation-in-progress state.
- [x] 1.8 Add regression coverage where restored `.gitmodules` metadata differs from `oms.yaml`, verifying metadata remains unstaged and the restore message mentions the update.

## 2. Pending Removal Restore

- [x] 2.1 Extend `syncRepo()` to inspect `gitlinkState()` before the unregistered `git submodule add` branch.
- [x] 2.2 Add a selected-alias restore path for pending or partial removal topology where root `HEAD` records the alias gitlink.
- [x] 2.3 Restore only the selected alias's `.gitmodules` section from `HEAD:.gitmodules` without overwriting unrelated `.gitmodules` edits.
- [x] 2.4 Restore or normalize the selected root gitlink path so `git submodule update --init -- oms/<alias>` can run without `already exists in the index`.
- [x] 2.5 Reuse existing remote reconciliation and branch attachment behavior after the restored submodule is initialized.
- [x] 2.6 Reconcile restored `.gitmodules` `url` and explicit `branch` values from `oms.yaml`, leaving those metadata diffs unstaged rather than adding them to topology commit semantics.

## 3. Safety and Output

- [x] 3.1 Emit a clear restore message when `oms sync` restores a pending removal, while preserving existing initialized or updated summary result semantics.
- [x] 3.2 Fail with guidance when pending removal cannot be restored safely, and do not fall through to `git submodule add`.
- [x] 3.3 Ensure topology finalization still runs after restore, and confirm a plain restore back to root `HEAD` does not prompt or commit when no pending topology remains.

## 4. Verification

- [x] 4.1 Run the full CLI test suite with `npm test`.
- [x] 4.2 Manually smoke-test the interactive `oms sync` path in a TTY if automated coverage cannot exercise the prompt.
