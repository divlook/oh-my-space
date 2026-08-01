## 1. Centralize Safe Branch Attachment

- [x] 1.1 Add an exhaustive `AttachBranchResult` to `scripts/lib/submodule-config.ts` that distinguishes already-attached, attached, diverged, and failed outcomes and carries the branch and required commit OIDs.
- [x] 1.2 Rework `attachBranch` to read full commit OIDs, create a missing baseline at `HEAD`, switch only when an existing baseline equals `HEAD`, preserve detached `HEAD` on divergence, and fail closed when equality or the Git operation cannot be established.
- [x] 1.3 Remove the duplicate branch-tip comparison from `initializeRegisteredAlias` in `scripts/lib/alias-preparation.ts` and route initialization through the shared attachment result without changing the preparation matrix.
- [x] 1.4 Add one attachment/reporting wrapper in `scripts/lib/repo-ops.ts` and route pending-removal restore, fresh add, registered initialization, and initialized update through it.
- [x] 1.5 Make the sync wrapper continue successfully on divergence with abbreviated current/baseline OIDs and explicit `oms branch switch <alias> <baseline>` and `oms pull <alias>` guidance, while preserving a non-zero result and Git diagnostics for attachment failure.
- [x] 1.6 Report only what the wrapper can prove on divergence — the unchanged checkout and root gitlink, not that the commit is the recorded pointer — and omit the baseline from the sync result line whenever `HEAD` stayed detached.
- [x] 1.7 Specify the preparation attachment-failure exit in the spec delta, the changeset, and `design.md`, since it is the one preparation behavior this change alters.

## 2. Exercise the Behavior End to End

- [x] 2.1 Build a scratch clone with root gitlink A and baseline tip B, run `oms sync <alias>`, and confirm exit 0, detached `HEAD` at A, an unchanged root gitlink/index, and the required guidance.
- [x] 2.2 Smoke-test the non-divergent paths: a missing baseline is created at `HEAD`, an existing baseline at `HEAD` is attached as a pure relabel, and an already-attached working branch is not disturbed.
- [x] 2.3 Smoke-test an attachment Git failure and confirm sync preserves repository state, reports the failed operation, and exits non-zero.

## 3. Add Regression Coverage and User Guidance

- [x] 3.1 Add a reusable sync fixture that records commit A, advances the remote baseline to B without recording it in the root, and clones the root with the drifted local baseline available.
- [x] 3.2 Add the load-bearing CLI regression asserting that sync preserves A in detached `HEAD`, leaves the root gitlink and index clean, reports both abbreviated commits without a remote URL, names the explicit switch and pull commands, and exits 0.
- [x] 3.3 Add focused contracts for missing, equal, already-attached, and failed attachment outcomes and for the reachable restore and initialized-update sync call sites.
- [x] 3.4 Run the existing shared alias-preparation contracts to confirm commit, fetch, pull, push, branch list, branch switch, branch checkout, and branch delete retain their preparation behavior.
- [x] 3.5 Update the README `oms sync` command reference and any matching `oms sync` help claim to state that sync reproduces the recorded pointer and does not advance to a newer baseline tip.
- [x] 3.6 Add a minor changeset that explicitly names the reversal for users who previously relied on sync as an implicit pull and directs them to `oms pull`; do not add a migration document.
- [x] 3.7 Add a preparation regression for a refused baseline attachment: the command exits non-zero with Git's diagnostic, the submodule stays detached at its checked-out commit, and root topology is unchanged.
- [x] 3.8 Assert the baseline suffix from both sides — present when the alias attached, absent when `HEAD` stayed detached.

## 4. Final Verification

- [x] 4.1 Run `npm run build` and the targeted sync/preparation contract tests.
- [x] 4.2 Run `npm test` and confirm the complete suite is green.
- [x] 4.3 Run `openspec validate sync-preserves-recorded-pointer --strict`.
