# Development

This guide covers contributor work on the OMS CLI.
For workspace installation and configuration, start with [Getting started](getting-started.md).

## Set up the repository

Use Node 24, as configured in [`.nvmrc`](../.nvmrc), for development and release preparation.
The published runtime range is `^24 || >=26`: Node 20, 22, and 25 are not supported.
Newer runtimes permitted by `>=26` are not all verified by CI.

```bash
nvm install
nvm use
npm ci
```

## Find the owning module

| Concern | Owning modules under `scripts/lib/` |
| --- | --- |
| Workspace discovery and root identity | `workspace-discovery.ts`, `source-workspace.ts` |
| Checkout identity, provisioning, and removal | `source-checkout.ts`, `clone-source.ts`, `remove-source.ts`, `removal-safety.ts`, `removal-history.ts` |
| Former-source ownership and diagnostics | `former-source.ts`, `status.ts`, `doctor.ts` |
| Legacy conversion and recovery | `migrate-source.ts`, `migration-plan.ts`, `migration-git.ts`, `migration-local.ts`, `migration-root.ts`, `migration-journal.ts` |
| Source-only Git operations | `source-preparation.ts`, `source-attachment.ts`, `commit.ts`, `manage-ops.ts` |
| Managed-tree inspection and lifecycle | `tree-inventory.ts`, `tree-context.ts`, `tree-exclude.ts`, `tree-ops.ts` |
| Root-local ignore updates | `local-exclude.ts` for locked writes; `clone-source.ts` and `tree-exclude.ts` for rule selection |
| Branch protection and confirmed cleanup | `source-branch-context.ts`, `source-safety.ts`, `branch-clean-plan.ts`, `branch-clean.ts` |
| CLI installation and registry transport | `package-install.ts`, `install-context.ts`, `registry.ts`, `update.ts` |
| Installed skill discovery, classification, reporting | `skill-discovery.ts`, `skill-classification.ts`, `skills.ts` |

Keep shared observations below command implementations. CLI routing and raw argument handling belong in `scripts/oms.ts`.
The [refactoring decision log](refactoring-decisions.md) explains the seams and retained exceptional policies.

## Build

```bash
npm run build
```

The build checks TypeScript types without output from `tsc`.
It then bundles the CLI into `dist/oms.js`.

## Test

Run the canonical full gate:

```bash
npm test
```

The full gate checks types and builds once.
It then runs the unit, integration, and black-box test layers.

The integration and black-box layers share immutable bare-repository and canonical-workspace seeds prepared after the build.
Each test receives private copies of mutable Git state, including its source and upstream.
Standalone layer commands prepare and clean up their own seeds. Standalone `test:integration` builds the CLI first because the canonical API seed uses `clone`.
Use `workspaceWithApi()` for an already provisioned independent `api/main` checkout. Keep dedicated submodule fixtures for legacy migration and recovery; ordinary source tests should not require a gitlink.

Pull-request CI has one required validation job, `test (development)`, on `.nvmrc` Node 24.
It reuses verification only when the content fingerprint, resolved Node version, runner image, and architecture match exactly.
On a cache miss, it installs dependencies, runs the complete suite, inspects the package, and records a verification marker.
The separate `current` Node diagnostic is non-gating and does not replace Node 24 validation.

For focused work, use the layer or stable feature script that covers the change:

```bash
npm run test:unit
npm run test:integration
npm run test:blackbox
npm run test:scaffold
npm run test:sync
npm run test:commit
npm run test:branch
npm run test:tools
```

### Test layer reference

Place each new contract at the least expensive layer that exercises its meaningful boundary.

- `tests/unit` covers parsing, validation, planning, and state decisions. These contracts need neither a Git process nor an owned filesystem fixture.
- `tests/integration` covers direct library entry points. Their behavior depends on real Git or filesystem state in a disposable fixture.
- Black-box owners cover production-bundle wiring and process-integrity/recovery behavior. They also cover at least one end-to-end journey per public command.

Compatibility tests must use explicit runtime versions, skill requirements, and registry versions for each scenario rather than deriving the compatibility condition from the package release version.
Use `currentVersion` when checking the actual package version or keeping installed and reference skill versions equal; use `OMS_TEST_PACKAGE_VERSION` to fix the simulated OMS runtime version.

Protected process-integrity/recovery and production-bundle-wiring contracts stay black-box unless an equivalent replacement retains that boundary.
You may consolidate or remove other journeys only when observable coverage remains.
Each executable contract lives in the `.test.js` or `.test.ts` file that owns its execution; shared fixture helpers do not register tests or choose shards.
Register each contract with a top-level `node:test` call and a literal name. The inventory rejects dynamic names and unsupported registration forms instead of omitting them.
For a new black-box contract, record why it needs the production process before regenerating the inventory.
Branch-clean integration contracts have separate owners for baseline eligibility (`branch-clean.test.ts`), confirmation and revalidation (`branch-clean-confirmation.test.ts`), and transactional failures and recovery (`branch-clean-transactions.test.ts`).
Their shared fixture module registers no tests, so the existing integration concurrency can schedule these owners without filtering contracts.
Each migration must record its replacement or deletion reason in `tests/test-inventory.json`.
That inventory also records source-file ownership, reviewed process-boundary classifications, and the enforced black-box contract cap.
`npm run test:inventory` checks the inventory.

### Performance evidence

Keep ongoing performance measurements in `tests/performance/`, independently of active or archived OpenSpec changes.

- `owner-durations.json` records current test-owner timings used by `node scripts/validate-test-inventory.mjs --write`, with earlier snapshots retained in `history`.
- `suite-benchmarks.json` records complete-suite measurements and is uploaded by CI.

The required CI job uploads its performance evidence even when the 55-second check fails; a failed check still prevents package inspection and verification-marker publication.

Measure the full gate without enforcing a wall-clock budget:

```bash
node scripts/benchmark-test-suite.mjs --runs 1 --label manual
```

After building, measure a selected black-box owner:

```bash
node scripts/benchmark-test-owners.mjs --owner tests/cli-tree-a.test.js
```

Black-box `[OK]` lines include each child process's wall time, including startup and fixture cleanup.
Concurrent build and real-Git layer phases also report their wall times.
Refresh all black-box owner measurements before regenerating their execution order:

```bash
node scripts/benchmark-test-owners.mjs --owner-prefix tests/cli-
node scripts/validate-test-inventory.mjs --write
```

The benchmark scripts update these files. Preserve reviewed historical measurements when running temporary diagnostics.
Acceptance budgets remain a three-run local median of at most 110 seconds, no local run above 135 seconds, and a cache-miss Node 24 CI Test step of at most 55 seconds.
Use `--gating` with at least three runs for local Node 24 acceptance, or `--ci-gating` for the Node 24 CI budget.

`untangle-inspection.json` records historical 2.x production-bundle comparisons for status, multi-alias preparation, branch cleanup, and root finalization. `operation-inspection.json`, `fixture-setup.json`, and `status-inspection.json` also include historical 2.x measurements. To assess independent clones, measure the suite or owner on the revision you are evaluating.

### Direct test runs

Feature scripts rebuild `dist/oms.js` before they run their black-box tests.
If you invoke Node's test runner directly, build first:

```bash
npm run build
node --test tests/cli-branch-a.test.js
```

### Fixture reference

The test Git environment disables automatic maintenance and garbage collection.
These settings prevent background Git processes from changing a fixture during copying.
Bare fixtures also set `receive.autogc=false` because local push receivers do not inherit Git environment configuration overrides.
These settings apply only to disposable test repositories and test processes.
Each worker removes its test fixtures in one batch when it exits.

### Inspect retained fixtures

To inspect fixtures after a failure, retain them:

```bash
OMS_TEST_RETAIN_FIXTURES=1 npm test
```

Read the worker-root path from standard error.

## Prepare a release

Stable releases use Changesets and the package scripts:

```bash
npm run changeset
npm run version
npm run release
```

Review package contents before publication.
`npm run version` requires pending Changesets. With Changesets 3, an empty plan fails with exit code 1, leaves package metadata unchanged, and skips the subsequent lockfile refresh.
Review release metadata before publication.
Follow [Release channels](release-channels.md) for the authoritative maintainer steps.

### Release reference

`prepack` runs the project's package validation before publication.
Stable and beta channels have different publication and rollback flows.
The [Release channels](release-channels.md) guide covers beta dry runs, dist-tag checks, stable promotion, and rollback, plus the GitHub CLI contents-write prerequisite, npm `gitHead`/remote-tag/Release completion checks, and metadata-only recovery after partial stable-release failure.
