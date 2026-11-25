# Spec Delta

## ADDED Requirements

### Requirement: Independent checkout release targets OMS 3.0
OMS SHALL record the breaking independent-checkout and migration release as a Changesets major release targeting `3.0.0`. Version preparation and publication SHALL remain separate maintainer operations.

#### Scenario: Release intent is prepared
- **WHEN** the independent-clone implementation is ready for release preparation
- **THEN** the pending Changesets plan resolves `oh-my-space` to `3.0.0` without publishing or changing npm tags

### Requirement: Beta versions derive from the Changesets stable target
Beta releases SHALL use semver prerelease identifiers with the `beta` label and SHALL derive their stable base from the pending Changesets release plan, not from maintainer-entered version text or the version already published on npm `latest`.

#### Scenario: First beta for OMS 3.0
- **WHEN** pending Changesets resolve `oh-my-space` from the preceding stable version to the intended `3.0.0` release
- **AND** maintainers invoke the beta publisher
- **THEN** the package version uses `3.0.0-beta.sha-<current commit>`
- **AND** the maintainer does not supply `3.0.0` as a command argument
- **AND** the package does not use the preceding stable version as the beta base

#### Scenario: Release plan is missing
- **WHEN** maintainers invoke the beta publisher without a pending Changesets release for `oh-my-space`
- **THEN** the publisher stops before changing package metadata
- **AND** explains that a Changeset defining the intended stable release is required

#### Scenario: Release plan is ambiguous or invalid
- **WHEN** the Changesets output does not identify exactly one valid next stable version for `oh-my-space`
- **OR** the derived version is not greater than the stable version in repository package metadata
- **THEN** the publisher stops before packing or publishing
- **AND** reports the derived release-plan problem without guessing a version

#### Scenario: Iterating on beta feedback
- **WHEN** maintainers publish a follow-up beta after fixes while the same pending Changesets still resolve to the intended stable release
- **THEN** the publisher derives the same stable base again
- **AND** uses the new source commit short hash

### Requirement: Stable promotion publishes the matched stable version
The release process SHALL promote a beta-tested change by publishing the corresponding stable semver version to the npm `latest` dist-tag rather than retagging a prerelease package.

#### Scenario: Promoting the tested OMS 3.0 beta
- **WHEN** maintainers determine that the `3.0.0-beta.sha-<commit>` line is stable enough for general use
- **THEN** they publish `3.0.0` to the npm `latest` dist-tag
- **AND** the stable channel does not point to a prerelease version
- **AND** the beta package itself is not retagged as stable

## REMOVED Requirements

### Requirement: Current development line targets OMS 1.0
**Reason**: The current breaking change follows the published 2.x line.
**Migration**: Use the Changesets major release plan for OMS 3.0; historical releases remain unchanged.

### Requirement: Beta versions use the Changesets stable target
**Reason**: The independent checkout model replaces this contract and its legacy scenarios.
**Migration**: See the replacement requirement, Beta versions derive from the Changesets stable target.

### Requirement: Stable promotion uses stable semver
**Reason**: The independent checkout model replaces this contract and its legacy scenarios.
**Migration**: See the replacement requirement, Stable promotion publishes the matched stable version.

