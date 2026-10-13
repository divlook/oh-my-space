# Tasks

## 1. Contextual cleanup output

- [x] 1.1 In `scripts/lib/branch-clean.ts`, choose the empty/nonempty presentation only after successful preparation and full planning, omit routine no-initialization messages, and preserve actual initialization effects and exceptional diagnostics. Update existing integration scenarios for protected-only and unmerged no-ops, initialization followed by no candidates, shallow-history limitations, and inspection failures; delete the obsolete empty-path full-base assertion rather than pinning replacement prose. Verify with `npm run build` and `npm run test:integration`: empty plans exit 0 without a deletion prompt or full plan, failures stay nonzero, initialized and limited-history states remain accurately reported, and existing candidate, concurrency, recovery, and Git-boundary behavior passes.
- [x] 1.2 Smoke-run the built command in disposable initialized fixtures: a protected-only source, an unmerged-only source, and a nonempty candidate plan declined by the user. Observe the actual output and preserved refs/HEAD/index, then update the cleanup sections in `docs/commands.md` and `docs/how-oms-works.md` to describe concise no-ops and candidate-only plan details. Verify the documented behavior against the observed runs and retain the existing safety and recovery anchors and rules; remove temporary fixtures and instrumentation after recording evidence.

## 2. Quick-reference cleanup help

- [x] 2.1 Shorten `branchCleanHelp` in `scripts/lib/help.ts`: examples first, brief local-only/interactive-confirmation, default-base, cached-ref, and initialization guidance, then the existing detailed safety link. Remove `workspaceContextHelp` only from the cleanup command's appended help in `scripts/oms.ts`. Verify `npm run build`, `npm run test:branch`, and the actual `node dist/oms.js branch clean --help` output from outside an OMS workspace: exit 0, compact usage at 80 columns, examples easy to find, all existing options retained, no source preparation, no long safety/results/discovery appendix, and other command behavior unchanged. Do not introduce help snapshots or exact prose/line-count assertions.
- [x] 2.2 After the help smoke run, update the existing cleanup command documentation to make the quick-help versus detailed-safety split explicit and add an English Changeset summary for both output improvements. Verify the retained documentation URL targets `docs/how-oms-works.md#merged-branch-cleanup-safety`, the detailed rules and exit codes remain available, and the summary describes presentation changes without claiming new deletion semantics or safety guarantees.

## 3. Integrated acceptance

- [x] 3.1 Run the canonical `npm test` gate after both slices are integrated, retaining the existing integration and black-box owners. Verify the full gate passes; if contract ownership changed, update `tests/test-inventory.json` and verify `npm run test:inventory` without adding an unnecessary owner. Record exercised command output, exit behavior, initialization/history exceptions, and preserved Git boundaries alongside the acceptance evidence; do not use the user's repository as a deletion fixture.

## Workflow follow-up

- Before synchronizing or archiving this change, synchronize the predecessor `add-merged-branch-cleanup` so its cleanup requirements exist in the main `ai-submodule-workflow` spec. Do not overwrite its artifacts or archive it implicitly.
- Review and verify this change through the explicit OpenSpec verification/archive workflows after implementation is complete.

## Acceptance evidence

- `npm run build` passed. `npm run test:integration` passed after removing an over-specific assertion about propagated inspection-error wording; nonzero refusal, branch preservation, and absence of a successful no-op remain covered.
- `npm run test:branch` passed all 46 tests. `npm test` passed the canonical gate and recorded verification `0abd987f5611`. Inventory validation passed with 394 contracts; the existing integration and black-box owners remain, with two additional integration scenarios registered.
- Disposable production-bundle smoke runs for protected-only and unmerged-only sources both exited `0` and printed only `api: no eligible merged local branches to clean.` A candidate plan declined through the existing prompt adapter exited `1`, retaining the full base, branch tips, exclusions, and concurrency warning without a routine preparation notice.
- All three production smoke runs compared refs, root/source HEAD, and root/source indexes before and after; all were unchanged. Fixtures used the existing disposable helper and were removed on process exit, not the user's repository.
- Passing integration scenarios cover initialization followed by no candidates with retained baseline attachment/tracking and unchanged root HEAD/index, dirty unmerged-only preservation, shallow-history no-ops with deepen-or-repair guidance and unchanged state, and fail-closed inspection errors.
- Bundled `branch clean --help` outside a workspace exited `0` with examples before essential guidance, the existing options, and the retained `docs/how-oms-works.md#merged-branch-cleanup-safety` URL. An additional `COLUMNS=80` run with a Git refusal stub invoked no Git and created no files. No permanent help snapshots or wording/line-count assertions were added.
- Updated `docs/commands.md`, `docs/how-oms-works.md`, and `.changeset/quiet-branch-clean-output.md`; detailed safety/recovery anchors, exit codes, and deletion semantics remain unchanged.
