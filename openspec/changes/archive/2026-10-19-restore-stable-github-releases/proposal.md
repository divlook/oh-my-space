# Proposal

## Why

OMS 2.0.0 and 2.0.1 were published to npm, but their Git tags were not pushed and their GitHub Releases were not created. The deployed Changesets Action detects publication using `New tag:` output that Changesets CLI 3.0.3 no longer emits, allowing incomplete releases to appear successful.

## What Changes

- Complete stable GitHub release metadata from verified npm publication and source commit identity, without parsing human-readable Changesets output.
- Keep Changesets for version PRs and npm publication, but give one explicit finalization path ownership of remote tags and GitHub Releases.
- Recover `v2.0.0` and `v2.0.1` at their published npm `gitHead` commits, using the matching changelog entries without republishing npm packages or moving dist-tags.
- Support safe completion after partial failure: preserve matching tags and releases, refuse conflicting identities, and fail visibly when finalization cannot complete.
- Document stable release completion checks and metadata-only recovery.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `release-channels`: Extend stable release completion to include verified remote Git tags and published GitHub Releases, and define metadata-only recovery without changing npm distribution.

## Impact

- `.github/workflows/release.yml`, stable release scripts under `scripts/`, and the `package.json` stable release entry point.
- `docs/release-channels.md`, the development release reference where needed, and focused release integration coverage following the existing script-fixture conventions.
- GitHub contents-write access and an authenticated GitHub CLI for finalization; existing npm trusted publishing and package validation remain in place.
- One-time remote metadata creation for two already published versions. No OMS command, Node support range, beta flow, dependency downgrade, npm version bump, or npm dist-tag change is intended.
