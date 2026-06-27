## 0. Prep

- [x] 0.1 Create and switch to a feature branch (e.g. `fix/unify-root-topology-preflight`) off the latest `main` before making any changes

## 1. Shared preflight in the status spine

- [x] 1.1 Move `readAliasDirEntries` (and its `AliasDirEntries` type) from `scripts/lib/repo-ops.ts` into `scripts/lib/status.ts` and export it
- [x] 1.2 Update `syncRepo`'s existing `!registered` branch in `repo-ops.ts` to import `readAliasDirEntries` from `status.ts` (no behavior change)
- [x] 1.3 Add `RootTopologyCheck`/`RootTopologySafety` types and `assertRootTopologySafe(repoRoot, alias, checks?)` to `status.ts`. It composes `gitlinkState(...).conflict`, `gitOperationInProgress(repoRoot)`, and the occupied-non-submodule-path check; evaluates only the caller-requested checks in the fixed order `conflict` → `inProgressOp` → `occupiedPath`; and returns `{ safe: false, reason }` on the first failing applied check. `checks` defaults to all three
- [x] 1.4 Centralize the `reason` fragments (`conflicted`, `in progress`, `occupied by a non-submodule`) so messages stay consistent across callers

## 2. Apply the preflight to unsync

- [x] 2.1 In `unsyncRepo` (`repo-ops.ts`), call `assertRootTopologySafe(repoRoot, alias)` (all three checks) after the `!registered && !exists` `"nothing-to-remove"` short-circuit but before any `git submodule deinit` / `git rm` / `rmSync`; on `safe: false`, `log.error` the reason and return `"failed"`. The occupied-path branch is the one that previously fell through to the destructive `rmSync` at `repo-ops.ts:356-358`
- [x] 2.2 Ensure the occupied-non-submodule-path refusal applies to the unregistered-but-occupied case and never deletes or mutates the occupying path; confirm the preflight's registration/existence inputs agree with `unsyncRepo`'s existing `registered`/`exists` computation (no inconsistent double-classification)
- [x] 2.3 Confirm `runUnsync`'s per-alias loop treats a preflight refusal as a per-alias `failed` result without aborting sibling aliases (including `--all` and interactive multi-select)
- [x] 2.4 Fix `runUnsync`'s aggregate failure message (`repo-ops.ts:587-591`) so it no longer hardcodes "uncommitted or untracked changes" as the cause for every `"failed"` outcome; the dirty-tree guidance must appear only for the dirty-tree failure path, while conflict / in-progress / occupied-path refusals surface their own per-alias reason (logged in 2.1) without a contradictory aggregate cause

## 3. Route record through the shared preflight

- [x] 3.1 In `runRecord` (`commit.ts`), delegate the conflict / in-progress-op checks to `assertRootTopologySafe(repoRoot, alias, ["conflict", "inProgressOp"])` (no `occupiedPath` — `record` never occupies `oms/<alias>`), keeping the record-specific checks (headOid, `!pathExists`, split, unrelated staged paths) and preserving existing messages, the conflict-before-in-progress ordering (`commit.ts:117-127`), and exit codes

## 4. Regression coverage

- [x] 4.1 Add a test: `unsync` against a non-submodule file occupying `oms/<alias>` fails with a deterministic message, leaves the file intact, does not report unsynced, exits with status `2` (matching the mirrored sync occupied-path test), and whose output does NOT contain "uncommitted or untracked changes" (guards against the aggregate-message regression fixed in 2.4)
- [x] 4.2 Add a test: `unsync` during an in-progress root operation fails before `deinit`/`rm` with a deterministic message, exits with status `2`, and produces no "uncommitted or untracked changes" cause
- [x] 4.3 Add a test: `unsync` of a conflicted root gitlink fails before `deinit`/`rm` with a deterministic message, exits with status `2`, and produces no "uncommitted or untracked changes" cause
- [x] 4.4 Add a regression test asserting `unsync` still removes a normal registered submodule and follows the existing topology finalization policy
- [x] 4.5 Run the full suite (`npm test`) and confirm the existing `record` and `sync` tests still pass unchanged

## 5. Release hygiene

- [x] 5.1 Add a changeset (`.changeset/*.md`) describing the unsync data-loss fix and the shared preflight as a patch-level behavioral change
