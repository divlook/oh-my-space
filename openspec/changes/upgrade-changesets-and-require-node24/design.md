# Design

## Context

See `proposal.md` for motivation and scope. OMS currently declares Node `>=20.19.0`, bundles for `node20`, and uses `@types/node` 20. Required CI validates Node 20.19.0 and `.nvmrc` Node 24; a separate latest-runtime benchmark is non-gating. Release CI already uses `.nvmrc`.

The lockfile and installed CLI resolve to Changesets 2.31.0. The beta publisher imports `getReleasePlan()` directly and derives a stable target before it modifies package metadata. Stable version preparation runs `changeset version && npm install --package-lock-only --ignore-scripts`.

## Goals / Non-Goals

**Goals:**
- Use one Node 24 baseline across development, releases, type checking, bundling, and required verification.
- Keep permitted runtimes distinct from runtimes actually verified by CI.
- Upgrade the connected Changesets packages together without weakening release-plan errors or package lifecycle checks.

**Non-Goals:**
- Add runtime-version guards, package-manager enforcement, or a new dependency-management convention.
- Change workspace commands, beta identifiers, publication authentication, or npm tags.
- Upgrade unrelated dependencies or rewrite historical OpenSpec artifacts and benchmark evidence.
- Publish a package as part of implementation.

## Decisions

### 1. Declare `^24 || >=26`; build and develop on Node 24

Replace the package engine range and its lockfile root counterpart with `^24 || >=26`. Keep `.nvmrc` at `24`, set the esbuild target to `node24`, and select a current compatible `@types/node` 24 release without changing the existing TypeScript language target merely to match the Node major.

`>=24` was rejected because it includes the end-of-life Node 25 line. Enumerating every permitted future major was rejected because it would require metadata changes before users could adopt each new runtime. The open-ended range permits future versions but does not promise successful verification of all of them. No custom startup rejection is added; package managers retain their normal engine-policy behavior.

### 2. Use one required CI runtime and retain the latest-runtime diagnostic

Remove the Node 20 matrix entry and redundant matrix-selection steps, leaving one required Node 24 job using `.nvmrc`. Preserve pull-request-only triggers, cancellation, exact verification keys, cache-miss installation, canonical suite execution, package inspection, and marker recording. Preserve the separate `current` diagnostic and its non-gating status.

Keep existing performance limits: local three-run median at most 110 seconds, maximum at most 135 seconds, and cache-miss required CI Test step at most 55 seconds. Update current policy references to Node 24; retain historical measurements as historical evidence. Inspect any branch-protection dependency on the old required job name before renaming the job; avoid silently removing a required check.

Keeping the old matrix shape with two Node 24 entries was rejected because it would duplicate work without adding runtime coverage.

### 3. Upgrade Changesets as one compatible set

Use the stable package ranges verified during exploration: CLI `^3.0.3`, release-plan `^5.0.2`, and GitHub changelog `^1.0.1`. Refresh the lockfile using the existing npm convention. Point `.changeset/config.json` at the schema version actually resolved by the upgraded CLI; retain existing repository, branch, public-access, and changelog settings unless the new schema requires migration.

The new packages are ESM. OMS already uses ESM and the beta publisher uses an ESM import, but the real release-plan result must still be checked. Keep the existing import and orchestration if compatible; migrate only API usages that the upgrade actually breaks. Upgrading only the CLI was rejected because it would leave stable and beta release planning on different package generations.

### 4. Adopt empty-plan failure without a compatibility shim

Keep `npm run version` as a failing operation when there are no unreleased Changesets. With CLI 3, `changeset version` returns 1, so the `&&` lockfile update does not run. Do not suppress the error or restore the old successful no-op behavior. Document this maintainer-visible change.

Use disposable fixtures for version preparation: an empty plan must fail without metadata changes; a valid release intent must produce the expected stable version and consume that intent. Exercise changelog generation with local deterministic inputs rather than requiring a live GitHub mutation. Verify the existing release action's behavior with pending and absent release intent before changing any workflow logic.

### 5. Preserve beta behavior and make the runtime removal a major release intent

Retain the custom beta publisher rather than switching to Changesets prerelease mode. Its stable target, HEAD-derived identifier, dirty-tree protection, metadata restoration, and opt-in publication remain unchanged. Validate it through a non-publishing dry run in a disposable clean checkout.

Add a major Changeset explaining the new runtime requirement and migration path during implementation. Do not manually change the package version or move dist-tags. Existing Changesets determine the combined next stable target through the ordinary release process.

## Risks / Trade-offs

- Node 20 and 22 users cannot adopt the next major release under the supported policy → Provide explicit Node upgrade guidance in onboarding and release intent.
- Future permitted runtimes may have regressions → Keep the latest-runtime diagnostic and document that Node 24 is the required baseline.
- Changesets 3 changes exit behavior and package exports → Verify actual empty and non-empty version preparation and direct release-plan consumption; do not hide failures.
- CI job renaming can conflict with external branch-protection configuration → Check required-check naming before renaming and report any external configuration action separately.
- Beta dry runs alter temporary metadata and can create package outputs → Run in a disposable checkout, verify restoration and version parity, and never pass `--publish`.

## Migration Plan

1. Establish Node 24 package, type, bundle, CI, and current documentation policy together; run the existing canonical verification gate.
2. Upgrade the Changesets package set and schema; verify the actual stable and beta paths without publication.
3. Add the major Changeset and final maintainer documentation; verify package metadata and built CLI parity on Node 24.
4. Observe the required Node 24 CI result and latest-runtime diagnostic before release readiness is claimed. Preserve the existing performance budgets.
5. Publish only through a later explicit maintainer release operation. Before publication, rollback is a revert of the scoped implementation. After public consumption, do not unpublish or silently restore old runtime support; use a separately reviewed release if recovery is required.
