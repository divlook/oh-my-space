## Context

The CLI entrypoint (`scripts/oms.ts`) is primarily command wiring and is mostly healthy, but several implementation modules under `scripts/lib/` have accumulated multiple responsibilities:

- `repo-ops.ts` combines sync, unsync, fetch, pull, push, branch switching, checkout, pending-removal recovery, result summaries, and cleanup behavior.
- `manifest.ts` combines manifest parsing/loading with legacy migration guards, `.gitignore` cleanup, remote reconciliation, and branch attachment.
- `doctor.ts` owns install-context and update-command detection that is also required by `update.ts`.
- `commit.ts` combines submodule commits, root pointer recording, and root topology commit finalization.
- `status.ts` combines status rendering with shared gitlink/topology state inspection.

The code is safety-sensitive because OMS deliberately separates root repository topology commits from submodule source commits. The refactor must therefore keep behavior intact and move code in small, testable slices.

## Goals / Non-Goals

**Goals:**

- Clarify module responsibilities without changing CLI behavior.
- Reduce awkward dependencies such as `update.ts` importing install-context helpers from `doctor.ts`.
- Keep root/submodule safety logic single-sourced and easy to locate.
- Prefer low-risk file moves and narrow helper extraction over broad rewrites.
- Preserve existing help text, command options, exit-code semantics, interactive prompts, and non-interactive behavior.
- Complete this change after the low-risk extractions are done; defer sync/unsync decomposition to a follow-up change unless the user explicitly approves that higher-risk scope separately.

**Non-Goals:**

- No public CLI command changes.
- No new persistence format, manifest schema, or migration behavior.
- No new runtime dependencies.
- No redesign of the OMS submodule workflow.
- No broad abstraction layer over all git commands.

## Decisions

### Decision 1: Extract install-context helpers before command-level refactors

Move install/update context detection from `doctor.ts` into a dedicated internal module, `scripts/lib/install-context.ts`.

Rationale:

- `detectInstallContext`, `collectRuntimeEvidence`, `globalUpdateCommand`, and `formatCommand` are not doctor-only concepts.
- `update.ts` should depend on a neutral helper module, not on the doctor command module.
- This is a small, behavior-preserving first step with clear tests.
- Registry lookup, semver comparison, command availability, update execution, and prerelease guidance remain in `update.ts` because they are update-command concerns rather than install-context classification.

Alternative considered: leave helpers in `doctor.ts`. This keeps fewer files but preserves an inverted dependency that makes future command code harder to reason about.

### Decision 2: Split topology commit finalization out of `commit.ts`

Move `finalizeTopology` and its private helpers into a dedicated module, `scripts/lib/topology-commit.ts`. Move root index path inspection into `scripts/lib/root-index.ts` so both `runRecord` and topology finalization can share it without making either command module depend on the other.

Rationale:

- Sync and unsync use topology finalization, but they should not need to import from the submodule commit command module.
- Root topology commits are conceptually distinct from `oms commit` and `oms record`.
- This preserves the safety behavior while making the dependency graph clearer.
- `stagedRootPaths` is shared root-index safety logic, not specifically commit or topology command logic.
- `root-index.ts` should expose only general staged-root-path inspection; topology-specific filtering remains in `topology-commit.ts`.
- `topology-commit.ts` owns the topology commit prompt and related output because those are part of topology finalization policy.

Alternative considered: split all of `commit.ts` into separate `submodule-commit.ts` and `record.ts` immediately. That is reasonable, but extracting topology first provides the highest value with less churn.

### Decision 3: Keep gitlink/topology state centralized while separating rendering later

Do not initially split the safety-critical state functions out of `status.ts` unless a later task needs it.

Rationale:

- `gitlinkState`, `pendingAddTopology`, `pendingRemovalTopology`, `partialRemovalTopology`, `assertRootTopologySafe`, and `rootFollowupHint` are shared safety contracts.
- Moving them too early creates risk without immediately improving command boundaries.
- If `status.ts` remains too broad after lower-risk refactors, a later extraction to `gitlink-state.ts` can happen as a dedicated step.

Alternative considered: split `status.ts` first. This may improve naming, but it touches several safety-sensitive callers at once.

### Decision 4: Decompose `repo-ops.ts` from the least risky edges inward

Extract smaller command groups before touching sync/unsync topology recovery.

Suggested order:

1. Extract operation result summary helpers to `scripts/lib/operation-results.ts`.
2. Extract branch operations (`runSwitch`, `runCheckout`) to `scripts/lib/branch-ops.ts`.
3. Extract manage operations (`runManage`, fetch/pull/push helpers) to `scripts/lib/manage-ops.ts`.
4. Leave sync and unsync in `repo-ops.ts` for this change; extract them only in a separately approved follow-up.

Rationale:

- Branch and manage operations are less coupled to pending topology recovery than sync/unsync.
- Sync/unsync contain the most destructive filesystem and git topology logic, so they should move last.
- `oms.ts` should import moved command runners directly from their new modules instead of relying on `repo-ops.ts` re-exports, so the broad module stops acting as the central command surface.
- `operation-results.ts` should own both summary output formatting and exit-code calculation to preserve the existing aggregate output behavior in one place.
- After the low-risk completion point, `repo-ops.ts` should contain only sync/unsync and their private helpers.

Alternative considered: split `repo-ops.ts` by command in one large move. That would produce the cleanest final shape faster, but it increases review and regression risk.

Alternative considered: keep `repo-ops.ts` as a compatibility re-export layer. That reduces import churn but preserves the broad module as an unnecessary command hub.

### Decision 5: Split `manifest.ts` by semantic responsibility after command dependencies are clearer

Once `repo-ops.ts` dependencies are reduced, split only the lowest-risk `manifest.ts` helpers into focused modules:

- `manifest.ts`: manifest validation and loading.
- `workspace-ignore.ts`: `ensureOmsNotIgnored` and `gitignoreIgnoresOms`.
- `submodule-config.ts`: `gitmodulesBranch`, `attachBranch`, and `ensureRemotes`.

Keep legacy rename/worktree guards and hints in `manifest.ts` for this change.

Rationale:

- This aligns file names with behavior.
- Deferring this until after command-level dependency cleanup avoids large import churn in one step.
- Legacy guards are still closely tied to `loadRepos` / `loadForSubmodules`; splitting them now would add churn without addressing the main dependency problems.
- Split `workspace-ignore.ts` before `submodule-config.ts` because the ignore helpers are simpler file operations, while submodule config helpers participate in sync/restore behavior.
- Do not re-export moved helpers from `manifest.ts`; call sites should import the new modules directly.

Alternative considered: split `manifest.ts` first. This is viable, but `repo-ops.ts` currently imports many of these functions, so doing it early may make the largest file even noisier during transition.

### Decision 6: Remove only obvious duplication

Accept small duplication when it keeps command-specific policy readable. Consolidate only low-risk cases:

- Merge duplicate repeatable option collectors in `oms.ts`.
- Consolidate package-root upward search helpers in the extracted install-context module.

Do not merge the status table and JSON divergence helpers in this change.

Rationale:

- Over-generalizing CLI preflight logic can hide important differences between commands.
- The goal is clarity, not minimizing line count.
- The status table and JSON output have different presentation needs; merging their upstream divergence helpers risks obscuring output semantics for little benefit.
- Name the shared repeatable option collector in `oms.ts` `collectRepeatable`.

### Decision 7: Use direct helper module imports without re-export compatibility layers

Do not leave compatibility re-exports from broad modules such as `doctor.ts`, `manifest.ts`, or `repo-ops.ts` after moving helpers.

Rationale:

- These modules are internal implementation details rather than public APIs.
- Re-export layers would preserve the same broad-module dependency pattern this refactor is trying to remove.
- Direct imports make command dependencies explicit and easier to review.

### Decision 8: Preserve black-box CLI test boundaries

Keep tests centered on the built CLI (`dist/oms.js`) rather than importing private helper modules directly.

Rationale:

- Existing tests are black-box CLI tests, so internal module moves should not force test consumers to track private paths.
- The current environment-variable hooks already allow update and install-context behavior to be exercised through CLI commands.
- Direct helper tests can be added later only if a new helper develops complex behavior that is impractical to verify through the CLI.

### Decision 9: Verify in layers

Run `npm run build` after small extraction steps and `npm test` after meaningful groups and final completion.

Rationale:

- `npm test` already includes build and the full Node test suite.
- Running full tests after every file move is likely slower than useful, while skipping intermediate build checks would delay TypeScript/import failures.

If baseline `npm test` fails before implementation starts, stop and report the failure before changing code. For failures after a slice, fix obvious import/type/test fixture issues within the slice; if behavior becomes unclear or the failure exceeds refactor scope, revert that slice and keep prior completed slices.

### Decision 10: Add a patch changeset

Add a patch changeset even though the change is behavior-preserving.

Recommended summary:

`Refactor OMS CLI internals to clarify module boundaries while preserving existing command behavior.`

## Risks / Trade-offs

- Import churn can create accidental behavior changes. → Move one responsibility at a time, run `npm run build` after small extractions, and run `npm test` after meaningful groups.
- Safety checks around root topology may regress if split too aggressively. → Keep gitlink/topology state centralized during early refactors.
- File count will increase. → Use new modules only where the name communicates a real domain boundary.
- Tests may couple to private module paths. → Preserve the current black-box CLI test boundary unless a future helper becomes impractical to verify through the CLI.
- Re-export compatibility layers can hide dependency cleanup. → Update call sites to import new helper modules directly.
- Some modules may remain larger than ideal after the first pass. → Prioritize stable behavior over achieving a perfect final layout in one change.

## Migration Plan

1. Run baseline `npm test`; stop and report if it fails.
2. Extract neutral helpers and update imports without behavior changes.
3. Split lower-risk command groups out of broad modules.
4. Verify behavior after each extraction with `npm run build`, and after meaningful groups with `npm test`.
5. Split only agreed low-risk manifest helpers (`workspace-ignore.ts`, `submodule-config.ts`) in this change.
6. Defer high-risk sync/unsync decomposition to a follow-up change unless the user explicitly approves that scope separately.
7. If any extraction causes unclear behavior or test instability, revert that extraction while keeping prior completed slices.
8. Add a patch changeset with a conservative internal-refactor summary.

Rollback is simple because this is an internal refactor: revert the affected commit or move the extracted functions back to their original module.

## Open Questions

- Are there any future module-boundary names that should be standardized beyond the agreed `install-context.ts`, `root-index.ts`, `topology-commit.ts`, `operation-results.ts`, `branch-ops.ts`, `manage-ops.ts`, `workspace-ignore.ts`, and `submodule-config.ts` names?
- Should a follow-up change introduce lint rules or module-boundary conventions to prevent the same growth pattern from recurring?
