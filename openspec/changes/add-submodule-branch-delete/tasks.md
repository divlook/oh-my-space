## 1. Deterministic Prompt Infrastructure

- [x] 1.1 Add `OMS_TEST_PROMPT_RESPONSES` as a reusable JSON queue enabled only with `OMS_TEST_MODE=1`, using typed `select`, boolean `confirm`, and `cancel` entries.
- [x] 1.2 Validate the exact entry schema and prompt-type ordering; fail with exit 1 for malformed JSON, unknown shapes, wrong prompt types, or responses left unconsumed at command completion.
- [x] 1.3 Route branch action, alias, branch, and force prompts through the guarded adapter while preserving normal TTY detection and preventing fallback after test configuration errors.
- [x] 1.4 Add focused tests for activation guards, ordered consumption, malformed and wrong-type responses, cancellation, and unconsumed responses.

## 2. Branch Command Interface

- [x] 2.1 Register the `oms branch` command group and `branch delete [alias] [branch]` subcommand with `-f, --force`, help text, and unchanged top-level switch/checkout commands.
- [x] 2.2 Follow the existing `oms agent` command-group pattern for bare interactive action selection, cancellation, and non-interactive help with exit 1.
- [x] 2.3 Implement explicit initialized-alias selection for omitted aliases without current-path inference or sole-candidate auto-selection.
- [x] 2.4 Implement name-sorted local branch selection with current and baseline branches disabled and annotated; a sole deletable candidate still requires explicit selection and is never auto-selected.
- [x] 2.5 Report protected reasons and exit 0 without opening a selector when no deletable local branch exists.

## 3. Branch Safety Resolution

- [x] 3.1 Add focused Git helpers for local branch existence, full branch OID and short SHA, origin HEAD resolution, and detection of `MERGE_HEAD`, `rebase-merge`, `rebase-apply`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG`, and `sequencer` in the submodule Git directory.
- [x] 3.2 Validate unknown aliases and declared but unregistered aliases with exit-1 targeted sync guidance.
- [x] 3.3 Validate missing local branches and current-branch protection, including local-only guidance when a same-named remote branch exists.
- [x] 3.4 Reject detached HEAD that differs from the root gitlink and in-progress submodule Git operations while allowing root-gitlink-anchored detached retries, dirty submodule worktrees, and parseable dirty or in-progress root state.
- [x] 3.5 Resolve protected baselines from explicit `oms.yaml`, origin HEAD when branch is omitted, and every present `.gitmodules` worktree, index stage 0 or unmerged stage 1-3, and `HEAD` version; treat absence as no baseline, warn on drift, and fail closed with the source identified for unreadable content, invalid syntax, duplicate selected-alias sections, or multiple selected-alias path/branch values.
- [x] 3.6 Reject every resolved baseline during the deletion phase without further worktree, index, remote, or root mutation; preserve any registered-alias initialization already completed by the preparation phase.
- [x] 3.7 For an explicitly named registered but uninitialized alias, initialize only that existing submodule and re-run every deletion precondition; preserve resumable state on init or later validation failure, allow later invocations when detached HEAD still equals the root gitlink, and reject unregistered aliases without creating root topology.

## 4. Local Branch Deletion

- [x] 4.1 Implement safe deletion with `git branch -d` immediately after explicit or interactive target selection, without another confirmation prompt.
- [x] 4.2 Implement `-f, --force` as direct `git branch -D` after explicit or interactive selection, skipping every safe-delete attempt.
- [x] 4.3 Capture the selected branch full OID; immediately before initial safe deletion and every force deletion, re-resolve protected baselines and listed Git-operation markers, and immediately before force deletion revalidate the OID. Abort with exit 2 on concurrent safety or OID changes, retain Git worktree protection, and document the narrow residual race after validation.
- [x] 4.4 Preserve and display the original safe-deletion Git error, then offer one force retry with a default-No warning containing alias, branch, and full OID.
- [x] 4.5 Implement force acceptance, decline, cancellation, non-interactive retry guidance, and direct or retry force Git failures with exit codes 0 or 2 and no repeated prompt.
- [x] 4.6 Print normal success with short SHA; before every force attempt print the full OID and branch recreation command, then confirm force status on success. Quote every dynamic retry and recovery argument using POSIX shell single-quote escaping.
- [x] 4.7 Handle a branch disappearing after safe deletion failure as a successful concurrent no-op while keeping initially missing branches as exit-1 input errors.
- [x] 4.8 Keep linked-worktree rejection delegated to Git and preserve local-only, remote-preservation, and root-pointer invariants after any explicitly requested registered-alias initialization.

## 5. Unified Sync Planning and Finalization

- [x] 5.1 Before root mutation, reject an in-progress root operation, unmerged `.gitmodules`, or any staged selected OMS path whose blob or mode differs from its validated commit result; allow exact matches and preserve unrelated staged paths.
- [x] 5.2 Reconcile the local origin URL from the selected alias's authoritative `oms.yaml` `remotes.origin`, fetch that URL, then validate explicit manifest branches or refresh and validate origin HEAD when manifest branch is omitted, without immediately changing `.gitmodules`.
- [ ] 5.3 Snapshot root `HEAD`, real index, exact working-tree `oms.yaml` bytes and hash, and `.gitmodules` before topology mutation; compute the selected aliases' expected topology delta and verify actual post-topology content before using it as the metadata snapshot.
  - **Descoped** (conscious decision): the core concurrent-edit protection is implemented — `reconcileGitmodules` refuses when the live `.gitmodules` no longer equals its verified snapshot (6.1), and the finalize commit re-hashes the real index under the OMS lock before advancing `HEAD`. The additional precise pre-/post-topology *delta* verification (distinguishing OMS's own topology edit from a concurrent external edit) is not implemented. Residual risk is limited to multi-actor concurrent `.gitmodules` edits during a single sync; single-user workflows are unaffected.
- [ ] 5.4 Build and apply metadata plans only for successful initialized, existing, or pending-removal-restored aliases, then compare every snapshot plus selected gitlinks immediately before finalization and the working-tree manifest again immediately before commit; revalidate at most once and stage only the exact captured manifest bytes.
  - **Descoped** (conscious decision): metadata plans are built only for successful aliases, the exact captured `oms.yaml` bytes are staged verbatim (never re-read), and the real-index hash is rechecked under the OMS lock immediately before `HEAD` advances. The fuller multi-snapshot pre-finalization comparison (HEAD + `oms.yaml` + `.gitmodules` + gitlinks) with a single revalidation pass is not implemented. Residual risk is limited to concurrent edits between planning and commit beyond the index-hash guard; single-user workflows are unaffected.
- [x] 5.5 For every requested or accepted sync commit, build an owner-only temporary index from verified `HEAD`, synthesize `.gitmodules` using only successful aliases' OMS-managed fields, and include successful gitlinks plus the complete current `oms.yaml`.
- [x] 5.6 Before committing, disclose that complete `oms.yaml` inclusion consumes its prior staging and includes failed-alias or other manifest edits; consume other selected OMS paths only on an exact blob/mode match and preserve every other staged entry.
- [x] 5.7 For plain or interactive partial sync, skip the commit prompt and leave successful OMS changes unstaged.
- [x] 5.8 On temporary-index root commit failure before `HEAD` advances, preserve the real index byte-for-byte and keep working-tree changes, then print the original Git error plus exact `oms sync --commit` retry guidance.
- [x] 5.9 Route pending-removal restore metadata through the same verified planning and unified finalization path.
- [x] 5.10 Hash the real index, acquire its lock, recheck the hash while locked, prepare its post-commit replacement by replaying prior staged entries except consumed `oms.yaml` and exact-matching committed OMS paths, and atomically install it after `HEAD` advances.
- [x] 5.11 Before Git commit, durably write and fsync an owner-only intent marker with original `HEAD`, index hash, planned tree, and artifact paths; create artifacts only afterward and atomically record the created commit OID after `HEAD` advances.
- [x] 5.12 Retry post-commit index installation once; on exhausted failure or interruption preserve the original index, recovery index, and durable marker.
- [x] 5.13 Add a shared pre-mutation recovery preflight to every `sync` or `unsync` invocation that can change root topology or metadata and every `record` invocation; clean unchanged prepared state, validate parent/tree before promotion, and auto-install committed recovery only when locked `HEAD` and index hash match.
- [x] 5.14 Clean up temporary indexes and only process-owned locks on success and verified pre-commit failure; preserve and block on state mismatch, malformed markers, or owner-namespaced orphan artifacts with comparison guidance.

## 6. Atomic Gitmodules Reconciliation

- [x] 6.1 Compare current `.gitmodules` with the post-topology planning snapshot immediately before each atomic application and never retry a detected concurrent edit.
- [x] 6.2 Capture the original `.gitmodules` mode, create a same-directory owner-only temporary file, and apply all planned alias transformations while preserving unrelated content and formatting.
- [x] 6.3 Cancel the entire batch and preserve the original file if any alias transformation fails, returning exit 2 with unapplied aliases.
- [x] 6.4 Do not retry deterministic in-memory planning errors; retry only temporary-file serialization, write, or replacement failure once from a fresh owner-only file while the planning snapshot remains unchanged.
- [x] 6.5 Keep the temporary file owner-only until atomically replacing `.gitmodules`, then retry original-mode restoration once; after a second mode failure leave the file owner-only and print `chmod 0<mode> '<absolute-repo-root>/.gitmodules'` with POSIX path escaping.
- [x] 6.6 Prevent root finalization after an exhausted metadata or mode retry, report exit 2 with the precise retained state, and avoid claiming rollback when reconciled owner-only content remains.
- [x] 6.7 On any metadata planning, application, concurrent-change, replacement, or mode-restoration failure, leave completed topology changes as an unstaged, resumable working-tree result; define the original metadata file as the verified post-topology snapshot.
- [x] 6.8 Report changed field names without URL values and preserve the current submodule branch.
- [x] 6.9 Remove temporary metadata files on every success, failure, and exception path and ensure they are never staged.

## 7. CLI Verification

- [x] 7.1 Test safe deletion without a second confirmation, normal short-SHA output, remote-ref preservation, and unchanged worktree, index, and root state.
- [x] 7.2 Test `-f` and `--force` with explicit targets and interactive alias/branch selection, proving direct `-D` skips safe deletion.
- [x] 7.3 Test action, alias, and branch selection; disabled protection hints; single candidates; no-candidate exit 0; cancellation; non-interactive omissions; and the exact guarded prompt queue schema.
- [x] 7.4 Test alias, local branch, current branch, every applicable metadata source and absence case, duplicate or malformed metadata, unknown default, unanchored detached rejection, root-gitlink-anchored detached retry across invocations, init network/failure/validation-failure state, every listed submodule operation marker, allowed dirty root state, and unregistered rejection.
- [x] 7.5 Test force acceptance, default-No decline, cancellation, POSIX-shell-safe non-interactive guidance, direct and retry Git failures, linked worktrees, concurrent OID, baseline, and operation-marker changes, concurrent branch disappearance, and pre-delete full-OID recovery output.
- [x] 7.6 Test ordinary metadata-only sync, authoritative manifest `remotes.origin` when local origin and `.gitmodules` disagree, explicit branch validation, omitted-branch origin HEAD refresh and failure, URL/branch drift correction, branch-key removal, current-branch preservation, and URL-value redaction.
- [x] 7.7 Test metadata-only, pending-removal restore, and mixed topology-plus-metadata sync with and without commit, proving one finalization decision, complete changed-`oms.yaml` inclusion, and one commit for successful changes.
- [x] 7.8 Test mismatched staged OMS rejection, exact-matching staged OMS consumption, pre/post-topology and both pre-commit `HEAD`/manifest/index checks including the post-comparison manifest race, exact captured-manifest staging, all-success and partial temporary-index synthesis, complete manifest consumption and disclosure, failed-alias isolation, real-index replay, lock contention, interruption immediately before and after `HEAD` advance, shared `sync`/`unsync`/`record` recovery preflight, prepared-marker cleanup/promotion, one-time post-commit install retry, hash-matched automatic recovery, hash-mismatched preservation, malformed-marker and orphan blocking, plain partial non-prompt behavior, byte-for-byte real-index preservation on pre-HEAD commit failure, safe metadata retry, unstaged topology preservation after metadata failure, exhausted replacement and mode failures, restricted permissions, cleanup, and non-staging.
- [x] 7.9 Run the complete build and test suite and resolve any regressions.

## 8. User Guidance and Release

- [x] 8.1 Document `oms branch delete`, interactive flows, local-only scope, protected baselines, exit behavior, force OID safety, and recovery guidance in the README.
- [x] 8.2 Document unified topology/metadata finalization, partial-success automatic commit, safe one-time retries, required staged/conflict stops, shared `sync`/`unsync`/`record` recovery preflight and blocking states, branch-omitted origin HEAD requirements, and explicit origin branch validation in the README.
- [x] 8.3 Add `docs/migrations/0.11.x-to-0.12.0.md` covering unresolved origin HEAD, missing explicit origin branches, managed metadata overwrite, mismatched staged OMS rejection, complete working-tree `oms.yaml` consumption, explicit partial-success commits, and new `record` recovery preflight stops with diagnostics and recovery guidance; link it from the README migration table.
- [x] 8.4 Update the `oms-branch` skill to guide safe local branch cleanup and distinguish local deletion from remote branch operations.
- [x] 8.5 Add a minor release changeset describing branch deletion, declarative metadata reconciliation, and the stricter sync compatibility note.
