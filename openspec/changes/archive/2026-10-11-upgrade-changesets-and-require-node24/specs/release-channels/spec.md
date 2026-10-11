## ADDED Requirements

### Requirement: Stable version preparation requires release intent

Stable version preparation SHALL derive the next stable package version from pending Changesets. When no unreleased Changesets exist, `npm run version` SHALL fail with exit code 1 rather than report a successful no-op, SHALL leave package metadata unchanged, and SHALL NOT run the subsequent lockfile-refresh operation.

#### Scenario: Pending release intent is prepared
- **WHEN** maintainers run `npm run version` with a valid pending Changeset for `oh-my-space`
- **THEN** package metadata advances to the expected stable version
- **AND** the consumed Changeset is applied to the changelog
- **AND** the lockfile reflects the prepared stable package metadata
- **AND** no package is published or dist-tag moved by version preparation

#### Scenario: No unreleased Changesets exist
- **WHEN** maintainers run `npm run version` with no unreleased Changesets
- **THEN** the command exits with code 1
- **AND** package metadata remains unchanged
- **AND** the subsequent lockfile-refresh operation does not run

#### Scenario: Maintainer reads the version preparation instructions
- **WHEN** maintainers consult the release preparation documentation
- **THEN** it explains that pending Changesets are required and that an empty plan is a failed operation

### Requirement: Upgraded release planning preserves beta preparation

The release-tooling upgrade SHALL preserve the custom beta flow's stable target from pending Changesets, HEAD-derived prerelease identifier, explicit publication opt-in, and restoration of package metadata after a dry run. Missing or invalid stable release plans SHALL remain failures before package metadata changes.

#### Scenario: Valid pending plan is previewed
- **WHEN** maintainers perform a beta dry run from a clean commit with one valid forward stable release target
- **THEN** the beta version is `<stable target>-beta.sha-<current commit short hash>`
- **AND** the built CLI and package metadata agree on that beta version
- **AND** package metadata is restored when the dry run finishes
- **AND** no package is published or dist-tag moved

#### Scenario: Pending stable target is unavailable
- **WHEN** beta preparation has no valid forward stable release target
- **THEN** it fails before changing package metadata or packing an artifact
- **AND** it reports the release-plan problem without guessing a version
