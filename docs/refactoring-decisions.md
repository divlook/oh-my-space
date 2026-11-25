# Refactoring decisions

For module ownership, see [Development](development.md#find-the-owning-module). For command behavior, see [How OMS works](how-oms-works.md).

## Keep observation, selection, and mutation separate

Share checkout eligibility checks below the command layer so changes to diagnostics cannot alter write safety. Selection does not provision checkouts; commands that can use a fresh clone own the consent decision.

Pull uses a full branch ref and negative refspecs because Git can search other ref namespaces when the exact branch is missing.

## Recheck state at the point of mutation

Do not reuse observations across prompts, provisioning, or mutations. `exec` rechecks each checkout before launch because an earlier child can change a later target. Branch cleanup rechecks each candidate and verifies the approved commit IDs in the ref transaction; these checks do not lock out concurrent Git activity.

Branch cleanup refuses an incomplete batched operation check. Single-branch deletion can retry the marker lookups individually, but also refuses if those checks fail.

## Share the root-local exclude writer

Clone and tree creation share an atomic writer for the root repository's `info/exclude`. After renaming the lockfile into place, the writer leaves the lock path alone: it may already belong to the next writer. When tree creation needs to add a rule, it updates the file before creating a worktree or task branch.

## Verify legacy state consistently during migration

Planning, root-file edits, and recovery share Git registration parsing and index checks. Legacy submodule data belongs to each root worktree; local configuration is shared. Use worktree-local evidence to identify a legacy checkout, and preserve shared registrations still used by another root worktree.

Record the journal before moving Git data. Recovery accepts recorded pre- and post-conversion states and rechecks declarations, linked worktrees, and root state before further writes. Refuse relocation if it would break nested submodule links. See the [migration guide](migrations/2.x-to-3.0.0.md) for recovery steps.

## Keep external tooling failures in scope

- Stable updates validate the stable tag separately so malformed beta metadata cannot block them.
- Skill installation and discovery use the same repository identity. Discovery can proceed without external lock metadata; skill diagnostics do not change `doctor`'s exit status.
- Agent instruction edits validate all selected files before the first write. A malformed marker leaves every target unchanged; a later write failure does not roll back earlier writes.

## Keep verification tied to the behavior it protects

- Beta preparation and verification use the same metadata transformation. Keep temporary metadata in place until child processes exit, even on interruption. Collect bundle licenses by physical package directory so nested dependency versions are not collapsed. See [Release channels](release-channels.md).
- Keep tests at the cheapest layer that can catch the regression. Parser tests cannot replace checks of command diagnostics, and in-process tests cannot replace checks of the built CLI's wiring, streaming, signals, or crash recovery. See [Development](development.md#test-layer-reference).
