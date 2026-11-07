# Refactoring decisions

OMS keeps the existing command contracts, source/root Git separation, recorded-commit preservation, and recovery format. This log records the structural problems addressed by the codebase refactor and the exceptional policies deliberately retained.

## Put shared observations below commands

Shared state belongs to modules that do not import command implementations:

- `workspace-discovery.ts`: nearest-manifest discovery and Git-root identity.
- `workspace-state.ts`: gitlinks, topology decisions, change counts, record eligibility, and alias inference.
- `git-operation-state.ts`: one operation-marker inventory with explicit strict and permissive inspection policies.
- `tree-inventory.ts`, `tree-context.ts`, and `tree-exclude.ts`: managed-tree discovery, canonical-command context, and local exclusion.

Problems solved:

- `status.ts` owned safety decisions used by preparation, recording, synchronization, and branch deletion.
- `tree-ops.ts` combined discovery and context checks with creation/removal workflows.
- Preparation, synchronization, selection, status, and tree commands formed runtime dependency cycles.
- Three operation-marker lists could drift independently.
- Workspace discovery was coupled to Git process transport.

The resulting runtime import graph has no cycles. Observation failures retain their existing command-specific meaning; this refactor does not silently turn permissive inspection into strict refusal.

## Synchronize an explicit workspace, not another CLI invocation

`sync-workspace.ts` owns synchronization for an explicit root and selected declarations. `repo-ops.ts` owns CLI loading and selection. Preparation calls the workspace operation directly and supplies a redacting Git runner when needed.

Problems solved:

- Preparation accepted a root and repository but discarded them when it called `runSync`, rediscovering the workspace from the process working directory.
- Preparation changed `OMS_REDACT_GIT_DIAGNOSTICS`, which Git transport read implicitly.
- Successful repositories were correlated with results by array position or object identity.
- Single and batch preparation repeated existing-registration handling.
- Sync and unsync repeated root-recovery, metadata-conflict, and manifest-snapshot preflight.

Preparation outcomes are keyed by alias. `topology-preflight.ts` owns the common preflight, while each workflow retains its selection, partial-success, and finalization policy. No process-wide state cache was introduced.

## Keep selection, preparation, and routing distinct

Repository selection in `prompts.ts` no longer initializes or registers a repository. Branch workflows explicitly prepare their selection. Source commits and root pointer recording live in `commit.ts` and `record.ts`, respectively.

Problems solved:

- `resolveInitializedAlias` combined choosing a repository with mutating its registration.
- A generic single-alias resolver retained an unused record mode alongside the actual multi-alias record resolver.
- Branch deletion owned the bare branch menu, Commander coupling, and imports of every sibling branch workflow.
- The CLI maintained a second handwritten top-level command-name set.
- Removed push flags leaked into core operation options.
- Skills delegation read global argument positions inside its implementation.
- Remote/update prompts bypassed the existing guarded prompt seam.

The CLI now owns branch routing, unsupported push-flag diagnostics, and skills argument extraction. Its unknown-command guard derives names from actual registration. Branch menu entries reference their registered commands. Distinct sole-candidate and destructive-selection policies remain explicit.

## Share Git mechanics without merging safety policies

`git.ts` uses one spawn/result conversion implementation. `shell.ts` owns POSIX recovery-command quoting. Existing-branch switching and forced branch deletion each have one execution path.

Problems solved:

- Default and environment-specific Git runners duplicated process setup and result conversion.
- Recovery quoting and destructive execution were copied across workflows.
- A separate root-index module only forwarded one Git query.
- Root finalization exposed an unused operation discriminator and obsolete forwarding exports.
- A partially injected Git runner appeared to control the entire transaction.

The root transaction's `objectGitRunner` name identifies its actual scope. Buffered output and inherited credential input remain unchanged. Branch deletion uses typed current-branch protection rather than interpreting a rendered reason string.

## Observe baselines once, then apply the caller's policy

`branch-baseline.ts` shares captured-content validation and records baseline provenance as data. Strict deletion and degraded reporting remain separate consumers of those observations.

Problems solved:

- Strict and permissive resolution duplicated almost the complete metadata-source validation algorithm.
- Policy depended on whether human-readable reasons contained `.gitmodules`.
- Section ambiguity and value parsing were repeated, and parsing could reread a different live snapshot.

Strict resolution still refuses ambiguous or malformed evidence. Listing still reports reliable baselines alongside incomplete or unavailable evidence. Drift continues to protect every reliably resolved baseline.

## Share managed Git configuration transformations, not their seeds

`managed-gitmodules.ts` owns edits to managed fields and sections. Working-file reconciliation and root transaction synthesis apply those edits to their own captured content. Topology finalization accepts a named input object.

Problems solved:

- Working-file reconciliation and root finalization separately implemented URL/branch changes and nullable-branch removal.
- Metadata plans stored both an alias and its derivable path.
- Nine positional finalization arguments exposed bookkeeping and ordering to callers.

The working file and committed file intentionally start from different seeds. A root commit must not consume unrelated working `.gitmodules` edits. Existing no-op formatting, file modes, bounded retries, partial-success asymmetries, and durable recovery markers remain intact.

## Separate branch cleanup planning from execution

`branch-clean-plan.ts` owns `planBranchClean` and `executeBranchClean`. `branch-clean.ts` owns selection, preparation, confirmation, and reporting.

Problems solved:

- Candidate inspection, context snapshots, safety revalidation, destructive effects, and output were interwoven.
- Race tests waited for a particular branch name and commit ID to appear on stdout before mutating repository state.

Tests can now mutate real repository state between planning and execution. Execution still rechecks shared safety and candidate identity, preserves changed branches, and distinguishes completed deletion from failed configuration cleanup. Cleanup's strict registration snapshot remains local: its requirements intentionally differ from preparation's tolerant registration classification.

## Give package commands and registry transport one owner

`package-install.ts` builds package-manager argument vectors and formats them for display. `registry.ts` owns registry transport. Installation context and skill/update types live with their owning modules.

Problems solved:

- Global execution, channel guidance, and project guidance independently encoded package-manager syntax.
- Update and skill diagnostics duplicated registry URL, timeout, override, fetch, and HTTP handling.
- A central workspace type file depended on skill metadata and allowed unrelated installation-state combinations.
- Callers reconstructed manager/automatic-update fallback decisions.

Stable-only parsing and stable/beta compatibility parsing remain different policies. A malformed beta tag cannot prevent an ordinary stable update. Only confidently identified global installations permit automatic mutation.

## Separate skill discovery, classification, and reporting

`skill-discovery.ts` collects installations once per operation. `skill-classification.ts` evaluates freshness and compatibility. `skills.ts` reports findings and delegates installation.

Problems solved:

- Discovery rescanned the same directories separately for each skill and again for existence checks.
- Local inspection, classification, registry remediation, and presentation were coupled.
- Unavailable package-manager guidance could suppress otherwise useful compatibility-channel inspection.

Search locations, first-match precedence, provenance acceptance, scope grouping, and informational exit behavior remain unchanged. Reporting additional physical copies would be a separate behavior change.

## Plan managed instruction edits before applying them

Agent instruction operations read each selected file once, construct edits, reject malformed markers across the selection, then apply the plan.

Problems solved:

- Validation and mutation read the same file independently.
- The pure transformation and command preflight disagreed about malformed content.
- A helper accepted an action argument that never varied.
- Comments claimed generated single-sourcing or filesystem atomicity that the implementation did not provide.

Outside content, empty-file deletion, and the no-staging rule remain unchanged. This is selection-wide validation, not a new rollback transaction.

## Make tooling lifetimes and ownership explicit

Beta metadata transformation is shared with verification fingerprinting. The metadata lifetime encloses child completion, including interruption. License collection retains physical package roots from the bundle graph. Test-layer scheduling is selected explicitly and waits for child stream closure.

Problems solved:

- Beta preparation and fingerprinting shared a hidden package-format/version-string protocol.
- Restoration responsibility was split across metadata writes and signal handlers.
- License lookup discarded physical package identity and could collapse nested dependency versions.
- A hardcoded bundled-dependency list duplicated the bundle graph.
- Prepack attached an unused property to errors, and verification-record reading repeated the same fallback.
- The presence of `ownerOrder` implicitly selected a different test execution mode.
- Benchmark tools separately scanned argument positions.

Release publication, verified-result reuse, artifact rebuilding, version parity, channel restrictions, and stable-release recovery remain governed by the existing release documentation.

## Let real test files own execution

Test files contain the contracts they execute. Shared fixtures remain separate helpers; there is no environment-driven ordinal sharder. Inventory discovery assigns each contract to its source file.

Problems solved:

- Execution and inventory discovery separately interpreted wrapper/environment conventions.
- Inserting one contract redistributed unrelated contracts by declaration ordinal.
- Wrapper files had no responsibility beyond selecting a portion of another file.
- The inventory generator embedded preparation-specific historical paths and timings in active logic.
- Regeneration inferred process-boundary classifications from test-name keywords.
- Static help wording, incidental formatting, unrealistic inherited registry objects, and duplicate command-label permutations caused maintenance without additional regression coverage.

The inventory preserves historical baselines and records replacements or reasoned deletions. Existing process-boundary classifications survive regeneration. Crash recovery, credential input, streaming, interruption, source/root separation, and package gates remain behavioral regression surfaces. Fixture storage is allocated lazily.

## Exceptional policies deliberately retained

These cases express current requirements, not unfinished refactoring:

- Nearest-manifest authority, root Git identity, legacy-layout refusal, and canonical versus managed-tree scope.
- Explicit versus widened selection, default-No destructive confirmation, local-state requirements, and one registration offer per batch.
- Recorded-commit preservation, staged-first source commits, scoped root commits, and independent add/remove partial-success rules.
- Strict cleanup inspection versus permissive diagnostic/deletion probes; no universal reinterpretation of inspection failure.
- Bounded fetch, lock, index-install, metadata-install, and chmod retries; best-effort cleanup that must not mask the primary outcome.
- Git/platform layout variants, optional external skill metadata, informational registry failures, and justified permission/path test skips.
- The existing recovery-marker format, lock-generation limitations, external-concurrency restrictions, and documented cache-miss beta limitation.

No additional lock, retry framework, runtime cache, provider registry, or compatibility export layer was introduced.

## Verification

Verification ran locally on macOS arm64 with Node v24.21.0:

- `npm test` passed all 385 contracts.
- `npm pack --dry-run` passed, reused the matching canonical verification record, rebuilt the artifact, and inspected the six-file package.
- A real CLI journey exercised sync, JSON status, source-only commit/push, root recording, tree protection/removal, confirmed branch cleanup, literal child arguments, and unsync/restoration.
- Seven CLI scenarios retained identical exit codes, stdout, and stderr compared with the pre-refactor build.
- The final CLI/library graph contained 55 modules and 209 internal runtime imports, with no cycles.
- All contracts had exactly one physical source-file owner, and the 361-contract historical baseline remained unchanged.
- Domain reviews and repeated final structural reviews passed after repairing the bootstrap fixture's transitive-module copy.

Other platforms and runtimes were not exercised during this refactor. Test-runtime performance was not benchmarked.
