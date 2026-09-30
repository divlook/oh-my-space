# Development

This guide is for contributors working on the OMS CLI. Users installing and configuring a workspace should start with [Getting started](getting-started.md).

## Set up the repository

The project uses the Node.js version in [`.nvmrc`](../.nvmrc), currently Node.js 24.

```bash
nvm use
npm ci
```

## Build

```bash
npm run build
```

The build type-checks the TypeScript source without emitting from `tsc`, then bundles the CLI to `dist/oms.js`.

## Test

Run the canonical full gate:

```bash
npm test
```

It type-checks and builds once, then runs the unit, integration, and black-box test layers.

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

Place each new contract at the least expensive layer that exercises its meaningful boundary:

- `tests/unit` for parsing, validation, planning, and state decisions that need neither a Git process nor an owned filesystem fixture.
- `tests/integration` for direct library entry points whose behavior depends on real Git or filesystem state in a disposable fixture.
- Black-box owners for production-bundle wiring, process-integrity/recovery behavior, and at least one end-to-end journey per public command.

Protected process-integrity/recovery and production-bundle-wiring contracts stay black-box unless an equivalent replacement retains that boundary. Other journeys may be consolidated or removed only when observable coverage remains and each migration records its replacement or deletion reason in `tests/test-inventory.json`. That inventory also records deterministic owner assignment and the enforced black-box contract cap; `npm run test:inventory` checks it.

Feature scripts rebuild `dist/oms.js` before running their black-box tests. If you invoke Node's test runner directly, build first:

```bash
npm run build
node --test tests/cli-branch-a.test.js
```

Test fixtures are removed in one batch when each worker exits. To inspect fixtures after a failure, retain them and read the worker-root path printed to standard error:

```bash
OMS_TEST_RETAIN_FIXTURES=1 npm test
```

## Prepare a release

Stable releases use Changesets and the package scripts:

```bash
npm run changeset
npm run version
npm run release
```

`prepack` runs the project's package validation before publication. Review package contents and release metadata before publishing.

Stable and beta channels have different publication and rollback flows. Follow [Release channels](release-channels.md) for the authoritative maintainer steps, including beta dry runs, dist-tag verification, stable promotion, and rollback.
