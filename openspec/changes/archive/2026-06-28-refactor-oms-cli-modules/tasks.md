## 1. Baseline Verification

- [x] 1.1 Run the existing test suite and type checks to establish a pre-refactor baseline.
- [x] 1.2 Confirm tests remain black-box CLI tests and do not import private helpers from `scripts/lib/`.
- [x] 1.3 Stop and report before implementation if baseline `npm test` fails.
- [x] 1.4 Capture focused CLI behaviors to re-check after each extraction: `oms status --json`, `oms update --check`, `oms commit`, `oms record`, `oms sync`, `oms unsync`, `oms pull`, and `oms push`.

## 2. Install Context Extraction

- [x] 2.1 Create a neutral install-context helper module for runtime evidence, install-context classification, update command formatting, and global update command selection.
- [x] 2.2 Update `doctor.ts` to import install-context helpers from the new neutral module.
- [x] 2.3 Update `update.ts` to import install-context helpers from the new neutral module instead of `doctor.ts`.
- [x] 2.4 Consolidate duplicate package-root upward search helpers during the extraction if it stays behavior-preserving.
- [x] 2.5 Leave registry lookup, semver comparison, command availability, update execution, and prerelease guidance in `update.ts`.
- [x] 2.6 Run `npm run build`, then run update and doctor related CLI tests, including mocked install-context cases.

## 3. Topology Commit Extraction

- [x] 3.1 Move only general staged root path inspection into `root-index.ts` so record and topology finalization can share it.
- [x] 3.2 Move `finalizeTopology` and its private topology commit helpers from `commit.ts` into `topology-commit.ts`.
- [x] 3.3 Keep topology-specific staged path filtering and topology commit prompting/output in `topology-commit.ts`.
- [x] 3.4 Update `repo-ops.ts` to import topology finalization from the new module.
- [x] 3.5 Keep `runCommit` and `runRecord` behavior unchanged while reducing `commit.ts` to command-specific commit behavior.
- [x] 3.6 Run `npm run build`, then run tests covering sync topology commits, unsync topology commits, unrelated staged root changes, and topology commit failure handling.

## 4. Low-Risk Repo Ops Decomposition

- [x] 4.1 Extract operation result summary and exit-code helpers from `repo-ops.ts` into `operation-results.ts`.
- [x] 4.2 Move `runSwitch`, `runCheckout`, and their branch-operation private helpers into `branch-ops.ts`.
- [x] 4.3 Update `oms.ts` to import `runSwitch` and `runCheckout` directly from `branch-ops.ts`.
- [x] 4.4 Do not keep `repo-ops.ts` re-exports for moved branch operations.
- [x] 4.5 Run `npm run build`, then run tests or focused CLI checks for local branch switching, remote checkout, detached HEAD errors, and interactive branch selection.

## 5. Manage Ops Decomposition

- [x] 5.1 Move `runManage` plus fetch, pull, and push helpers into `manage-ops.ts`.
- [x] 5.2 Preserve remote resolution behavior, multi-alias continuation behavior, push unsupported flag failures, and root follow-up hints.
- [x] 5.3 Update `oms.ts` to import `runManage` directly from `manage-ops.ts`.
- [x] 5.4 Do not keep `repo-ops.ts` re-exports for moved manage operations.
- [x] 5.5 Run `npm run build`, then run tests or focused CLI checks for fetch, pull, push, repeatable `--remote`, dirty submodule handling, and moved-pointer hints.

## 6. Manifest and Workspace Helper Boundaries

- [x] 6.1 Split `.gitignore` OMS ignore helpers (`ensureOmsNotIgnored`, `gitignoreIgnoresOms`) out of `manifest.ts` into `workspace-ignore.ts`.
- [x] 6.2 Split submodule configuration helpers (`gitmodulesBranch`, `attachBranch`, `ensureRemotes`) out of `manifest.ts` into `submodule-config.ts`.
- [x] 6.3 Keep manifest validation, manifest loading, and legacy rename/worktree guards in `manifest.ts` for this change.
- [x] 6.4 Do not re-export moved helpers from `manifest.ts`.
- [x] 6.5 Preserve existing failure handling/logging behavior in `attachBranch` and `ensureRemotes`.
- [x] 6.6 Run `npm run build`, then run manifest validation, init, sync, and doctor tests after each split.

## 7. Sync/Unsync Boundary Confirmation

- [x] 7.1 Leave `runSync`, `syncRepo`, pending-removal restore helpers, `runUnsync`, and removal cleanup helpers in `repo-ops.ts` for this change.
- [x] 7.2 Keep gitlink/topology state functions centralized unless a separate follow-up extraction is explicitly approved.
- [x] 7.3 Record any remaining sync/unsync decomposition opportunities as follow-up notes instead of implementing them in this change.

Follow-up note: `repo-ops.ts` now primarily owns sync/unsync and their pending-removal recovery/removal cleanup helpers. A future change could split those safety-sensitive flows after a dedicated design review, but this change intentionally leaves them in place.

## 8. Small Duplication Cleanup

- [x] 8.1 Merge the repeatable option collectors in `oms.ts` into `collectRepeatable` if no command behavior changes.
- [x] 8.2 Keep the status table and JSON divergence helpers separate in this change.
- [x] 8.3 Avoid abstracting command-specific preflight checks when doing so would hide different command policies.

## 9. Final Verification

- [x] 9.1 Run the full test suite and type checks.
- [x] 9.2 Run focused CLI smoke checks for `oms --help`, `oms status --json`, `oms doctor`, `oms update --check`, and representative submodule workflow commands.
- [x] 9.3 Review the final import graph to confirm `update.ts` no longer imports from `doctor.ts` and `repo-ops.ts` no longer imports topology finalization from `commit.ts`.
- [x] 9.4 Confirm no public command names, options, help boundaries, or exit-code meanings changed.
- [x] 9.5 Confirm sync/unsync remain in `repo-ops.ts` and any deeper decomposition is captured only as follow-up work.
- [x] 9.6 Add a patch changeset with the summary: `Refactor OMS CLI internals to clarify module boundaries while preserving existing command behavior.`
