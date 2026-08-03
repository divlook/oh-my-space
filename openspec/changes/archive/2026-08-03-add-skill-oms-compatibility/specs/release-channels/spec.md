## ADDED Requirements

### Requirement: Current development line targets OMS 1.0
The release plan SHALL identify `1.0.0` as the intended stable version for the current post-`0.14.2` feature set, while keeping publication as an explicit maintainer operation.

#### Scenario: Prepare the next beta
- **WHEN** maintainers create a beta from the current development line
- **THEN** the package version is `1.0.0-beta.sha-<current commit>`
- **AND** the npm `beta` dist-tag moves to that version

#### Scenario: Prepare stable 1.0 metadata
- **WHEN** the compatibility work is completed
- **THEN** the repository contains a Changesets release intent that makes the next stable package version `1.0.0`
- **AND** completing the implementation does not itself publish or retag an npm package

## MODIFIED Requirements

### Requirement: Beta versions use the Changesets stable target
Beta releases SHALL use semver prerelease identifiers with the `beta` label and SHALL derive their stable base from the pending Changesets release plan, not from maintainer-entered version text or the version already published on npm `latest`.

#### Scenario: First beta for OMS 1.0
- **WHEN** pending Changesets resolve `oh-my-space` from `0.14.2` to the intended `1.0.0` release
- **AND** maintainers invoke the beta publisher
- **THEN** the package version uses `1.0.0-beta.sha-<current commit>`
- **AND** the maintainer does not supply `1.0.0` as a command argument
- **AND** the package does not use `0.14.2-beta.sha-<current commit>`

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

### Requirement: Stable promotion uses stable semver
The release process SHALL promote a beta-tested change by publishing the corresponding stable semver version to the npm `latest` dist-tag rather than retagging a prerelease package.

#### Scenario: Promoting the tested OMS 1.0 beta
- **WHEN** maintainers determine that the `1.0.0-beta.sha-<commit>` line is stable enough for general use
- **THEN** they publish `1.0.0` to the npm `latest` dist-tag
- **AND** the stable channel does not point to a prerelease version
- **AND** the beta package itself is not retagged as stable
