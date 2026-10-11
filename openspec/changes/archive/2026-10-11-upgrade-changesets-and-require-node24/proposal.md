# Proposal

## Why

Node 20 has reached end of life, while OMS still declares Node 20 support and validates it in CI. Changesets 3 requires newer runtimes; adopting it together with a Node 24 baseline keeps development, release tooling, and published package requirements aligned.

## What Changes

- **BREAKING**: Replace the published Node requirement `>=20.19.0` with `^24 || >=26`, ending support for Node 20, Node 22, and the end-of-life Node 25 line.
- Upgrade `@changesets/cli` to `^3.0.3`, `@changesets/get-release-plan` to `^5.0.2`, and `@changesets/changelog-github` to `^1.0.1`, the stable versions verified during exploration.
- Align the bundle target and Node type definitions with Node 24; keep `.nvmrc` on `24`.
- Replace the two-runtime required CI matrix with one Node 24 validation job, retaining the non-gating latest-runtime diagnostic and exact verification-key behavior.
- Align Changesets configuration with the upgraded config schema and adopt the version command's failure when no unreleased Changesets exist.
- Preserve stable release planning and the custom HEAD-derived beta flow without publishing or retagging packages during implementation.
- Update current support documentation and record the runtime support removal in a major Changeset. Preserve archived decisions and historical measurements.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `cli-bundle-packaging`: Declare the published runtime support range and Node 24 build baseline.
- `test-execution`: Make Node 24 the sole required CI runtime while retaining the latest-runtime diagnostic and existing performance budgets.
- `release-channels`: Define Changesets-backed stable version preparation, including failure on an empty release intent, while preserving existing beta and publication boundaries.

## Impact

- Package metadata and dependencies: `package.json`, `package-lock.json`, Node type definitions, and `.changeset/config.json`.
- Build and CI: `scripts/build.mjs` and `.github/workflows/ci.yml`; `.nvmrc` remains unchanged. Release CI continues to use Node 24.
- Release integration: `scripts/publish-beta.mjs` and its use of `getReleasePlan()` require verification against the new ESM package.
- Documentation: `README.md`, `docs/getting-started.md`, `docs/development.md`, and `docs/release-channels.md` as applicable.
- Consumers on removed Node versions must upgrade to Node 24 or another permitted runtime before adopting the next major OMS release. Future versions permitted by `>=26` are not all claimed to be verified.
- No workspace command behavior, repository boundaries, publication credentials, npm tags, or package publication is changed by the planning work.
