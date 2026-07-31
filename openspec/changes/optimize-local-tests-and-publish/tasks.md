## 1. Baseline and Contract Inventory

- [x] 1.1 Record the synchronized 295-test name inventory, current file ownership, and three complete M2/Node 24 timings with warm dependencies.
- [x] 1.2 Record representative cache-miss Test timings for the Node 20.19 and Node 24 CI matrix entries.
- [x] 1.3 Create the working old-test-name to replacement-test mapping and classify every contract as unit, shallow integration, or black-box.
- [x] 1.4 Identify every outcome-affecting ambient Node and Git setting inherited by the current harness and define the canonical normalized test environment.

## 2. Shared Fingerprint and Local Verification Record

- [x] 2.1 Add a dependency-free fingerprint module and common exclusion configuration that preserve path, content, and mode for all non-excluded tracked inputs.
- [x] 2.2 Extend local fingerprinting to relevant untracked inputs while excluding generated output, dependencies, and the verification record itself.
- [x] 2.3 Add exact environment identity collection for Node, Git, OS name/version, and architecture under the normalized test environment.
- [x] 2.4 Add the worktree-local latest-record schema, parser, atomic writer, invalidator, gitignore entry, and npm package exclusion.
- [x] 2.5 Cover fingerprint stability, sensitivity, fail-safe unknown paths, proven exclusions, relevant untracked files, malformed records, environment separation, and worktree isolation.
- [x] 2.6 Make canonical `npm test` snapshot inputs before execution, invalidate a matching record on failure, and write success only when the post-run fingerprint is unchanged.
- [x] 2.7 Make record-write failure a visible warning that preserves test success and forces later package operations to verify normally.

## 3. Verification-Aware Package Lifecycle

- [x] 3.1 Replace unconditional `prepack: npm test` with a verification-aware gate that reuses only an exact record and otherwise runs canonical `npm test`.
- [x] 3.2 Add `OMS_FORCE_TEST=1`, concise default reuse output, and `OMS_VERIFICATION_VERBOSE=1` audit output with verification time, key inputs, and source command.
- [x] 3.3 Make every reuse path type-check and rebuild the production bundle instead of trusting existing `dist` output.
- [x] 3.4 Add artifact checks that execute the fresh CLI and require CLI and package metadata versions to agree before pack or publish.
- [x] 3.5 Invalidate the matching record on build or artifact-check failure while retaining it after registry, authentication, or network failure.
- [x] 3.6 Cover direct `npm pack`, direct `npm publish`, repository release scripts, missing and damaged records, force mode, audit mode, and safe full-suite fallback.

## 4. Deterministic Beta Reuse

- [x] 4.1 Add logical fingerprint normalization for only the publisher-generated HEAD-derived beta value in the three designated package and lockfile version fields.
- [x] 4.2 Reject normalization for an unexpected prerelease, another commit hash, or any additional package or lockfile change.
- [x] 4.3 Make beta dry-run and publish always rebuild and verify the exact expected beta CLI and package versions after a verification reuse hit.
- [x] 4.4 Verify that a matching dry-run can serve a later unchanged publish, while changed source, environment, commit, or beta metadata executes the complete suite.
- [x] 4.5 Verify that beta metadata is restored on success, failure, and signals without invalidating an otherwise valid record for a registry-only failure.

## 5. Layered Test Harness and Production Seams

- [x] 5.1 Add the disposable `tsc` test-output configuration and Node test commands for unit, shallow integration, and black-box layers without adding a runtime dependency.
- [x] 5.2 Add layer-focused and feature-focused scripts that reuse canonical inventories but never create a complete verification record.
- [x] 5.3 Normalize ambient Node options, Git global/system configuration, hooks, commit identity, signing, and protocol settings in all canonical test processes.
- [x] 5.4 Introduce the raw injectable Git runner contract and route existing `runGit`, `runSub`, doctor version inspection, and root transaction input through explicit production implementations.
- [x] 5.5 Extract pure state classification, parsing, validation, redaction, formatting, and command-planning functions without changing public CLI behavior.
- [x] 5.6 Keep build, existing black-box coverage, and the new harness green while each seam is introduced.

## 6. Unit and Shallow Integration Migration

- [x] 6.1 Migrate Git result parsing, branch/ref inspection, dirty-state parsing, and sensitive URL redaction contracts to unit tests through the raw runner.
- [x] 6.2 Cover gitlink state, record verdict, topology classification, operation results, path inference, and dirty-count decisions with direct unit tests.
- [x] 6.3 Cover manifest validation, package update parsing, install commands, skill-version parsing, and agent block transforms with direct unit tests.
- [x] 6.4 Cover explicit prompt selection, non-TTY remote defaults, help scope, and command examples without starting the bundled CLI.
- [x] 6.5 Add shallow filesystem integration for fingerprint inputs, verification records, package metadata, prepack behavior, and beta publication restoration.
- [x] 6.6 Add shallow real-Git integration for fingerprint tree semantics, worktree-local records, and deterministic beta normalization.
- [x] 6.7 Retain the 295-contract mapping and prove every original black-box contract still runs exactly once through the deterministic shards.
## 7. Real Git and Black-Box Consolidation

- [x] 7.1 Replace repeated recursive fixture creation with immutable bare and workspace templates copied into isolated per-test roots.
- [x] 7.2 Partition branch-list contracts into two deterministic shards and branch, commit, and sync contracts into three shards each.
- [x] 7.3 Retain all root transaction crash stages and data-integrity failures against real repositories through the bundled compatibility layer.
- [x] 7.4 Retain bundled-CLI wiring coverage for every public command while adding direct unit and integration decision coverage.
- [x] 7.5 Keep the representative crash-and-recovery flows isolated and preserve retained-fixture diagnostics.
- [x] 7.6 Run every remote contract against local bare repositories without external servers.
- [x] 7.7 Keep mutable state isolated between tests and journeys, batch cleanup by file-owned temporary root, and preserve fixture-retention diagnostics.
- [x] 7.8 Complete and retain the final 295-name migration reconciliation in verification evidence.

## 8. CI, Release, and Performance Acceptance

- [x] 8.1 Replace the CI shell fingerprint calculation with the shared implementation while preserving exact cache keys, fail-safe exclusions, and pre-install lookup behavior.
- [x] 8.2 Verify that pull-request cache hits still report auditable success and that release validation always executes the canonical suite for main content.
- [x] 8.3 Verify that the release job's explicit `npm test` record lets the later Changesets publish reuse tests while still rebuilding and smoke-checking the artifact.
- [x] 8.4 Benchmark real-Git concurrency two, four, and six under comparable local conditions and select the faster stable explicit value.
- [x] 8.5 Run three complete M2/Node 24 `npm test` measurements and confirm a median of at most 60 seconds with no run above 75 seconds.
- [ ] 8.6 Run cache-miss Node 20.19 and Node 24 CI jobs and confirm each Test step completes within 60 seconds.
- [x] 8.7 If a target is missed, reduce non-destructive CLI process boundaries first and then retain representative real-Git root transaction stages while preserving all mapped contracts.
- [x] 8.8 Exercise canonical test, focused test, direct pack, direct publish simulation, beta dry-run, beta publish simulation, Changesets release simulation, force mode, and every verification fallback end to end.
- [x] 8.9 Run strict OpenSpec validation and record final timings, selected concurrency, package contents, marker behavior, environment keys, and contract mapping evidence.

## 9. Release Cleanup

- [x] 9.1 Remove obsolete test helpers, inventories, scripts, and temporary migration scaffolding after all replacement paths pass.
- [x] 9.2 Add the required Changeset describing faster canonical tests and safe package verification reuse.
