## 0. Discovery and Baseline

Dependencies: none. Section 1 starts only after this baseline is recorded in implementation notes or tests.

- [x] 0.1 Inventory every mutating command and shared helper that can write manifest, exclude, provisioning, provenance, ownership, recovery state, topology, refs, HEAD, index, working trees, or remote-tracking refs; map each entry point to the common mutation-lock wrapper and identify read-only commands explicitly, including every Git subprocess they invoke.
- [x] 0.2 Record existing submodule transaction, temporary-index, lock, root-commit, and recovery behavior that the mode-aware implementation must preserve.
- [x] 0.3 Inventory the status-v1 producer plus every in-repo and published consumer, and inventory the canonical agent kernel, marker block, skill copies, README, package metadata, and migration-document targets.
- [x] 0.4 With the repository's supported Node version, run `npm run build` and `npm test`, record both exit codes and any pre-existing failure, and require an understood green baseline before Section 1 implementation begins.

## 1. Manifest, Version, and Mode Foundations

Dependencies: Section 0.

- [x] 1.1 Extend manifest types, validation, and `oms.schema.json` with workspace-wide `submodule | worktree` mode and omitted-mode compatibility; in worktree mode reject HTTP(S) userinfo, URL passwords, query/fragment components, and executable transports with credential-helper or SSH-agent guidance.
- [x] 1.2 Raise the shared minimum Git version to 2.48 and make unsupported versions fail before every managed mutation with the relative-worktree rationale.
- [x] 1.3 Add mode-aware loading that keeps nearest-manifest discovery independent from submodule Git-root preconditions.
- [x] 1.4 Add canonical path helpers for `.oms/repos/<alias>.git`, `oms/<alias>/<name>`, aliases, compound targets, and enclosing Git relationships.
- [x] 1.5 Implement portable worktree-name normalization and validation, including a 64-ASCII-byte maximum, case-insensitive uniqueness, Windows reserved-name rejection, and a separate pre-mutation check for host filesystem limits on complete generated paths.
- [x] 1.6 Add manifest and version tests for valid modes, omitted mode, repository-level mode rejection, invalid init mode, and Git 2.48 enforcement.
- [x] 1.7 Add atomic mode-independent workspace ownership metadata, credential-free workspace IDs, alias ownership config, canonical containment checks, and fail-closed foreign/symlink path classification; for any new or existing manifest without identity, create exactly one ID during its first post-init mutation after acquiring and rechecking under the provisional canonical-target lock.
- [x] 1.8 Add exclusive workspace-root `.oms-mutation.lock` outside every mode topology, with non-secret operation identity, conservative stale-lock handling, and doctor recovery guidance; apply one common wrapper to the Section 0 inventory, including init, mode switch, sync, unsync, worktree lifecycle, record, commit, fetch, pull, push, branch mutations, submodule-mode branch list initialization/reconciliation/fetch, and every manifest, exclude, provisioning, provenance, ownership, journal, lock, recovery, topology, ref, HEAD, index, working-tree, or remote-tracking write; keep status, worktree list, worktree-mode branch list, help, and read-only doctor inspection lock-free while forcing all of their Git subprocesses to use `GIT_OPTIONAL_LOCKS=0` and non-mutating command forms; use a canonical-target hash for init and every pre-ownership mutation, atomically bind later state to the generated workspace ID, and hold the lock through identity bootstrap, journal completion, and final transition cleanup.

## 2. Common Repository and Worktree Inspection

Dependencies: Section 1.

- [x] 2.1 Implement bare common-repository initialization with relative-worktree configuration and no clone-created local branches.
- [x] 2.2 Implement authoritative declared-remote URL and fetch-refspec reconciliation while preserving undeclared remotes and rejecting additional URLs, pushurl drift, undeclared automatic upstreams, executable transports, and credential-bearing worktree-mode endpoints.
- [x] 2.3 Build a sanitized immutable network-Git configuration that scrubs `GIT_CONFIG_*`, isolates untrusted system/global/local URL rewrites while allowlisting required authentication settings, resolves and validates the effective fetch/push endpoint immediately before execution, and uses the same snapshot for the command.
- [x] 2.4 Implement atomic credential-free successful-fetch provenance keyed by effective endpoint/refspec fingerprint, invalidate trust across processes before drift changes, and restore it only after a complete successful fetch.
- [x] 2.5 Implement porcelain worktree inventory parsing with ownership/common-dir verification and managed, external, stale, locked, prunable, branch, HEAD, and canonical path classification.
- [x] 2.6 Implement managed-worktree Git state inspection for tracked dirtiness, ignored data, nested repositories, tracking divergence, detached state, recoverability, and in-progress operations.
- [x] 2.7 Implement enclosing Git discovery plus workspace-ID marker-managed `.git/info/exclude` reconciliation through `git rev-parse --git-path`, file locking, and atomic replacement; preserve permissions, line endings, user rules, `oms/AGENTS.md`, and `oms/CLAUDE.md`; keep workspace-relative `.oms/workspace.json`, `.oms-mutation.lock`, and `.oms-mode-switch.json` rules in every mode while adding or removing worktree-only `.oms/` child and checkout rules separately.
- [x] 2.8 Add low-level Git tests for relative metadata, moved whole workspaces, endpoint provenance across process interruption, `insteadOf`/`pushInsteadOf` and environment injection, effective-endpoint changes, remote refspecs, ownership mismatch, foreign and symlink paths, external paths, locks, stale registration, excludes, and case/path portability.

## 3. Worktree-Mode Sync and Remote Refresh

Dependencies: Sections 1-2.

- [x] 3.1 Route sync by workspace mode while preserving current submodule behavior and root transaction semantics.
- [x] 3.2 Provision a new worktree alias by atomically recording credential-free `.oms/provisioning/<alias>.json` phases `common-ready`, `branch-ready`, `worktree-created`, and `complete`; initialize the common repository, reconcile and fetch all remotes, resolve the baseline, create the first attached checkout, and retain `complete` after the final worktree is removed.
- [x] 3.3 Preserve common repositories, fetched objects, and the last validated provisioning phase while cleaning only incomplete checkout artifacts after initial provisioning failures; resume idempotently, adopt an interruption-created first worktree only when every recorded identity matches, and fail closed on missing, malformed, wrong-ownership, or Git-conflicting phase state beside an existing common repository.
- [x] 3.4 Implement interactive continue-or-cancel when only additional remotes fail during first provisioning, with non-interactive refusal and documented exit codes.
- [x] 3.5 Implement subsequent sync as remote reconciliation and fetch/prune only, without fast-forwarding branches or recreating removed worktrees; attempt every declared remote, preserve and report successful updates, aggregate operational failures as exit 2, and make reruns report already-current refs normally.
- [x] 3.6 Add safe managed stale-registration pruning that refuses possible manually moved worktrees and preserves external stale registrations.
- [x] 3.7 Add sync tests for explicit and remote-default baselines, unresolved origin HEAD, origin fetch failure and retry, branch creation followed by worktree creation failure and retry, interruption before and after each atomic provisioning phase, adoption before the `complete` write, malformed or conflicting phase state, successful completion followed by final-worktree removal and sync, additional-remote degradation, subsequent multi-remote partial failure and rerun aggregation, partial state, missing baseline warnings, and stationary local branches.

## 4. Worktree Lifecycle Commands

Dependencies: Sections 1-3.

- [x] 4.1 Add the `oms worktree` command group with `add`, `list`, `move`, and `remove` subcommands and help.
- [x] 4.2 Implement add input resolution, selected-remote fetch, local/remote/new branch precedence, `--from`, `--name`, and `--remote`.
- [x] 4.3 Implement provenance-backed cached-ref fallback for add, including stale warnings, cross-process invalidation, URL/refspec drift, and crash-between-config-and-fetch handling.
- [x] 4.4 Implement human worktree listing for declared aliases, zero-worktree repositories, managed worktrees, and external worktrees without a separate JSON contract.
- [x] 4.5 Implement worktree move with name validation, dirty-state preservation, and in-progress-operation refusal.
- [x] 4.6 Implement worktree remove with local branch preservation; tracked, ignored, nested, detached, and operation safeguards; complete force disclosure; deletion-boundary revalidation; and non-bypassable ownership, symlink, lock, and external-path protection.
- [x] 4.7 Define and implement fault-safe add/move/remove phases, documenting retained branches, directories, registrations, exit codes, and exact retry or doctor actions after each failure boundary.
- [x] 4.8 Add lifecycle tests for interactive and non-interactive inputs, normalization edge cases, name collisions, checked-out branches, cached provenance across processes, URL drift, ignored and nested data, detached unpublished HEAD, moves, injected partial failures, forced removal, branch preservation, locks, foreign paths, and external targets.

## 5. Mode-Aware Targets and Existing Commands

Dependencies: Sections 1-4. Status work in Section 6 may proceed in parallel after Section 2.

- [x] 5.1 Implement typed repository alias and `alias/name` target parsing and validation without performing candidate selection.
- [x] 5.2 Implement current-path, sole-candidate, interactive, and non-interactive managed checkout resolution with explicit-target precedence.
- [x] 5.3 Make commit operate on a selected managed worktree with existing staged-first behavior and no root pointer hint.
- [x] 5.4 Make fetch alias-scoped and default to every declared remote in worktree mode while preserving explicit declared-remote filtering and endpoint validation; attempt every selected remote after operational failures, preserve per-remote results, exit 2 on any operational failure, and make reruns safe.
- [x] 5.5 Make pull and push managed-target-scoped with declared-upstream-first fallback, managed-only `pull --all`, endpoint reconciliation, and independent aggregation; `pull --all` attempts every managed target, reports per-target results, and exits 2 for any operational failure, otherwise 1 for any safety refusal, otherwise 0.
- [x] 5.6 Make worktree-mode branch list a lock-free alias-scoped inspection of existing common local/remote refs and checked-out-at locations for managed and external worktrees, without initializing repositories, reconciling remotes, or fetching; preserve the mutation-locked initialization, reconciliation, and fetch behavior of submodule-mode branch list.
- [x] 5.7 Make branch switch and checkout target-scoped, add declared `--remote` support, enforce one-worktree-per-branch, and apply provenance-backed cached fallback.
- [x] 5.8 Make branch delete alias-scoped against the common repository and protect managed/external checked-out branches plus explicit or resolved baseline branches.
- [x] 5.9 Reject `oms record` in worktree mode with an explicit no-root-pointer explanation.
- [x] 5.10 Add cross-command tests for target inference, ambiguity, compound filters, dirty-current pull, detached-current commit, in-progress-current checkout, interactive reselection, non-interactive exit 1 without fallback, source-only commits, declared and undeclared upstreams, pushurl drift, executable transport rejection, subsequent sync/default-fetch and `pull --all` middle-failure aggregation and reruns, checkout conflicts, baseline protection, record refusal, and representative mutation-lock conflicts across manifest-only init, topology sync/unsync/worktree lifecycle/mode switch, root-index record, source commit/branch operations, and remote-tracking fetch/pull/push; every lock refusal must leave all files and Git state unchanged.

## 6. Status Schema Version 2

Dependencies: Sections 1-2; coordinate target filtering with Section 5.

- [x] 6.1 Add normative repository-root `oms.status.schema.json` covering every schema-v2 field name, type, required or optional status, nullability, discriminator, enum, and structured error shape; export matching TypeScript top-level, nullable root, submodule repo, worktree repo, managed worktree, and external worktree discriminated types.
- [x] 6.2 Preserve submodule pointer and repo status semantics inside the v2 discriminator while adding mode and current worktree/target fields.
- [x] 6.3 Build worktree-mode common repository and linked-worktree status with safe defaults, structured per-entry errors, and exit 2 on partial inspection failure.
- [x] 6.4 Report enclosing Git root path and same/ancestor relation, count the complete enclosing repository, and explicitly exclude generated OMS worktree paths plus `.oms/workspace.json`, `.oms-mutation.lock`, and `.oms-mode-switch.json` before, during, and after local-exclude reconciliation.
- [x] 6.5 Support alias and compound-target JSON filters and reject invalid mode-specific targets before emitting stdout.
- [x] 6.6 Render human worktree status as one row per worktree with an alias-level row when none exist.
- [x] 6.7 Update status help with the complete v2 contract and add runtime JSON Schema validation plus compile-time TypeScript contract fixtures for both modes, nullable roots, nested roots, external state, empty repos, filters, and partial failures; fail tests on schema/type/fixture drift.

## 7. Safe Unsync and Orphan Handling

Dependencies: Sections 1-5.

- [x] 7.1 Implement lock-protected worktree-mode unsync preflight across every managed and external registration, with ownership and safety revalidation immediately before each worktree and common-repository deletion.
- [x] 7.2 Fetch/prune all declared remotes and inventory every local branch, worktree HEAD, tag identity, stash, notes, replace/custom ref, reflog-only commit, and recoverable dangling object; fail closed when publication or reconstruction is unproven.
- [x] 7.3 Implement force disclosure for tracked, ignored, nested, detached, unpublished, metadata-ref, dangling-object, and in-progress managed state with refnames, object kinds, full OIDs, and no second confirmation.
- [x] 7.4 Make external or locked worktrees block unsync even with force and provide exact detach or unlock guidance.
- [x] 7.5 Discover explicitly named manifest-orphaned managed aliases and safely unsync them using every configured remote while excluding them from automatic and `--all` selection.
- [x] 7.6 Define per-alias deletion phases and partial-failure output so repeated unsync preserves completed work and resumes safely without misclassifying unexpected loss.
- [x] 7.7 Add unsync tests for clean published state, tracked and ignored files, nested repositories, detached HEAD, every protected ref namespace, dangling objects, remote failure, stale-force behavior, concurrent Git changes, operations, ownership/symlink mismatch, external and locked paths, orphan cleanup, and alias-rename non-inference.

## 8. Explicit Mode Switching

Dependencies: Sections 1-7.

- [x] 8.1 Add `oms mode switch <submodule|worktree>` with mutation locking, target-mode validation, journal-aware same-mode recovery, global preflight, orphan detection, and pre-mutation completion-scope selection through `--sync`, `--no-sync`, or an interactive selector; reject omitted scope non-interactively with exact command alternatives.
- [x] 8.2 Implement limited force semantics that waive only managed dirty, unpublished, or in-progress state, disclose committed/index/checkout/local-ref roles and full OIDs that will be discarded, and never waive external or locked boundaries.
- [x] 8.3 Implement durable workspace-root `.oms-mode-switch.json` outside every topology deletion set, containing credential-free original/expected manifest hashes, non-secret mode scalar range/token, phase, completed aliases, ownership ID, root-index snapshot metadata, and exclude hash/marker coordinates without copying manifest or exclude contents; bootstrap missing workspace identity under the provisional lock, compare-and-swap bind the still-owned lock to it before journal creation, and leave topology unchanged with doctor guidance if interrupted before that boundary; record matching target, workspace, operation, transition, PID, and process-start identities in the mutation lock; discover the journal before mode-specific loading; and compare-and-swap recover the lock only when every identity matches and the owner is conclusively gone, otherwise stop with doctor guidance before reconciling actual state for idempotent resume or drift refusal.
- [x] 8.4 Reject a symlink `oms.yaml` during preflight before journal creation or mutation, then edit only the top-level YAML mode source range located through the `yaml` package Document/CST API, preserving all untouched bytes, comments, quoting, ordering, indentation, and line endings through atomic same-directory replacement.
- [x] 8.5 Block unsafe root operations and use a temporary-index transaction to preserve unrelated entries, stages, modes, and flags while staging only transition-owned manifest and root-topology paths when `--commit` is absent, including verified target gitlinks when target sync is selected.
- [x] 8.6 Implement scoped `--commit` in both directions, reject unrelated staging, verify the final path whitelist, disclose without printing manifest contents, include existing manifest edits and selected target-sync topology, handle hook/signing failure, and use the fixed Conventional Commit message.
- [x] 8.7 Preserve mode-independent `.oms/workspace.json` unchanged across every transition and interruption; remove only owned mode-specific `.oms/repos/`, `.oms/provisioning/`, and fetch-provenance children; preserve the source manifest mode and completed removals after caught failures before manifest cutover; after atomic manifest replacement, resume toward the persisted target mode, detect an already successful optional root commit without duplicating it, keep the workspace-root lock and journal available after mode-specific state removal, and print exact partial-state and resume guidance.
- [x] 8.8 During successful transition away from worktree mode, remove only marker-managed mode-specific repository and checkout exclude entries with locked atomic updates and journaled recovery; preserve the same marker's mode-independent `.oms/workspace.json`, `.oms-mutation.lock`, and `.oms-mode-switch.json` rules.
- [x] 8.9 Gate standalone target-mode sync while a journal, unexpected old-mode filesystem or index topology, or incomplete exclude cleanup exists, while allowing journal-owned sync only after expected staged entries and phase state validate.
- [x] 8.10 Add a submodule source-state inventory for root HEAD gitlinks, every index stage, checked-out HEADs, all local branches, tags, stash, notes, replace/custom refs, and recoverable reflog-only or dangling objects; distinguish commit reachability from complete ref identity, metadata, and object-closure reconstruction; add fresh-fetch publication checks, interactive preserve-or-cancel handling with manual-publication guidance, a strict prohibition on remote writes by mode switch, and non-interactive `--sync --preserve-local` or force requirements for every non-reconstructible item.
- [x] 8.11 Implement journal-owned staged common repositories that import non-conflicting local branches and safe metadata refs; with replacement lookup disabled, copy and verify raw reachable closure for commits, parents, trees, blobs, nested tags, both replace-ref sides, and anchored objects; run staged-repository connectivity checks before source deletion; preserve local-baseline precedence without resetting its tip and retain only declared valid upstreams; install idempotently during target sync; and stop on incomplete closure, invalid refnames, ref collisions, or connectivity failure.
- [x] 8.12 Implement worktree-to-submodule pointer-source resolution using, per alias, ownership-verified registered and canonically contained managed worktrees with an existing readable path, readable committed HEAD, and complete local object closure; keep detached, dirty, locked, and in-progress sources visible while applying global transition safeguards; use sole-source automatic selection, interactive per-alias selection, repeated non-interactive `--source <alias/name>`, or a freshly resolved baseline when no viable source exists; before source deletion, create a journal-owned staged target submodule repository outside source deletion sets, fetch declared remotes, copy and verify any selected unpublished OID and object closure, retain a valid selected branch/upstream or preservation ref, install idempotently at the target module path, check out the OID, and stage the matching gitlink.
- [x] 8.13 Add fault-injection transition tests for both directions; `--sync` and `--no-sync`; interactive and non-interactive scope selection; committed, staged, unstaged, and split pointers; independent branches, tags, stash, notes, replace/custom refs, reflog-only and dangling objects; metadata identity not reconstructible from a reachable commit; missing parent/tree/blob/nested-tag/replace-side objects; connectivity failure; preserved baseline divergence and upstream retention or removal; manual-publication guidance with no transition-triggered push; preserved, unavailable, conflicting, and force-discarded OIDs; single, multiple, detached, dirty, locked, in-progress, and absent worktree pointer sources; published and unpublished selected target OIDs; object-copy and OID-verification failures before source deletion; selected-OID force protection; nested/non-Git target rejection; symlink-manifest preflight refusal with unchanged link and target; concurrent first-mutation identity bootstrap; workspace-ID byte and mode-independent local-exclude preservation across every mode-specific deletion and interruption boundary; root status and commit filtering while lock/journal files exist; interruption before and after provisional-lock identity binding and journal creation; proven-dead, live, PID-reused, malformed, and identity-mismatched lock recovery; complex index preservation and owned staging; commit hooks/signing; exact YAML byte preservation; staged-repository import and installation; manifest-rename interruption; commit-success interruption; exclude failure; orphan blocking; same-mode resume; drift refusal; and standalone versus journal-owned target-sync gating.

## 9. Init, Doctor, Guidance, and Documentation

Dependencies: Sections 1-8 for final help and docs; init and doctor foundations may begin after Section 2.

- [x] 9.1 Add lock-protected `oms init --mode` scaffolding using the canonical target hash as its provisional pre-ownership lock identity, plus mode-specific target validation and next-step output while retaining default submodule compatibility and AI setup guidance; test concurrent init and init racing another mutation without partial manifest, ownership, or Git changes.
- [x] 9.2 Extend doctor as a read-only mode-aware diagnostic for ownership, mutation locks, transition journals, remote endpoint policy/provenance, common repositories, refspecs, relative metadata, managed/external/locked/stale state, symlinks, excludes, orphans, and incompatible topology.
- [x] 9.3 Add exact manual-move repair diagnostics without automatic repair or destructive prune.
- [x] 9.4 Update CLI descriptions and command help to distinguish alias-scoped, `alias/name`-scoped, submodule-only, and worktree-only behavior and exit codes.
- [x] 9.5 Update the canonical kernel and marker block in `scripts/lib/agent.ts` plus `skills/oms-workspace/SKILL.md`, `skills/oms-pointer/SKILL.md`, and `skills/oms-branch/SKILL.md`; extend literal-substring drift tests across all four copies.
- [x] 9.6 Update README and package metadata with mode comparison, both layouts, both quick starts, worktree non-pinning, and Git 2.48 requirements.
- [x] 9.7 Add migration documentation for status v1 to v2, Git 2.48, and explicit submodule/worktree transitions, including rollback limits.

## 10. End-to-End Verification

Dependencies: Sections 1-9.

- [x] 10.1 With Node 20.19 or newer and Git 2.48 or newer, run `npm run build` for type checking and bundling, then run `npm test` for the complete test suite, including all existing submodule integration tests; require both commands to exit 0 and fix every regression.
- [x] 10.2 Add end-to-end worktree-mode tests in plain, Git-root, nested-Git, and moved-workspace contexts using local remotes, foreign/symlink collision fixtures, and fault injection.
- [x] 10.3 Verify every new prompt through guarded deterministic responses and every non-interactive path without fallback to real prompts.
- [x] 10.4 Verify documented exit 0, 1, and 2 behavior for successful, degraded, safety-refused, and operational-failure paths.
- [x] 10.5 Run `openspec validate add-worktree-mode --strict` and require exit 0; reconcile the Section 0 mutation, read-only Git-subprocess, transaction, status-consumer, agent-kernel, and documentation inventories against the final implementation; map every worktree, status-v2, context, init, README, and AI-skill scenario to an implementation or integration test and treat any uncovered scenario or inventory item as release-blocking.
- [x] 10.6 Add one cross-channel and on-disk credential canary suite covering stdout, stderr, JSON errors, prompts, doctor/debug output, command diagnostics, common-repository config, provisioning state, provenance, journals, locks, temporary/backup/recovery files, including encoded userinfo/query/fragment/header forms and control characters.
- [x] 10.7 Add golden status-v2 contract fixtures, review every fixture diff against the normative v2 contract, verify every in-repo and published consumer is v2-aware, update release environments to Git 2.48+, and document downgrade refusal while worktree or transition state exists; unreviewed fixture changes or any remaining v1 consumer block release.
- [x] 10.8 Run status, worktree list, worktree-mode branch list, and read-only doctor inspection alone and concurrently with representative mutations; assert `GIT_OPTIONAL_LOCKS=0` reaches every lock-free inspection Git subprocess and manifest bytes, OMS state files, refs, index bytes, worktree contents, and topology remain unchanged; separately verify that submodule-mode branch list takes the mutation lock for initialization, remote reconciliation, and fetch, and that lock refusal leaves all workspace and Git state unchanged.
