# Development

This guide covers contributor work on the OMS CLI.
For workspace installation and configuration, start with [Getting started](getting-started.md).

## Set up the repository

Use the Node.js version in [`.nvmrc`](../.nvmrc).

```bash
nvm use
npm ci
```

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

Protected process-integrity/recovery and production-bundle-wiring contracts stay black-box unless an equivalent replacement retains that boundary.
You may consolidate or remove other journeys only when observable coverage remains.
Each migration must record its replacement or deletion reason in `tests/test-inventory.json`.
That inventory also records deterministic owner assignment and the enforced black-box contract cap.
`npm run test:inventory` checks the inventory.

### Performance evidence

Keep ongoing performance measurements in `tests/performance/`, independently of active or archived OpenSpec changes.

- `owner-durations.json` records test-owner timings used by `node scripts/validate-test-inventory.mjs --write`.
- `suite-benchmarks.json` records complete-suite measurements and is uploaded by CI.

Measure the full gate without enforcing a wall-clock budget:

```bash
node scripts/benchmark-test-suite.mjs --runs 1 --label manual
```

After building, measure a selected black-box owner:

```bash
node scripts/benchmark-test-owners.mjs --owner tests/cli-tree-a.test.js
```

The benchmark scripts update these files. Preserve reviewed historical measurements when running temporary diagnostics.

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
Review release metadata before publication.
Follow [Release channels](release-channels.md) for the authoritative maintainer steps.

### Release reference

`prepack` runs the project's package validation before publication.
Stable and beta channels have different publication and rollback flows.
The [Release channels](release-channels.md) guide covers beta dry runs, dist-tag checks, stable promotion, and rollback.
