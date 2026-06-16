## Purpose

Define how `oh-my-space` separates stable and beta npm package distribution channels.

## Requirements

### Requirement: Stable and beta npm channels
The release process SHALL define stable and beta channels using npm dist-tags for the `oh-my-space` package.

#### Scenario: Stable release remains default
- **WHEN** a user installs `oh-my-space` without specifying a tag or version
- **THEN** the package manager resolves the npm `latest` dist-tag

#### Scenario: Beta release is opt-in
- **WHEN** a user installs `oh-my-space@beta`
- **THEN** the package manager resolves the npm `beta` dist-tag

#### Scenario: Dist-tags are distinguishable
- **WHEN** maintainers inspect the package dist-tags
- **THEN** the `latest` tag identifies the stable version
- **AND** the `beta` tag identifies the current prerelease version when one is available

### Requirement: Beta versions use prerelease semver
Beta releases SHALL use semver prerelease identifiers with the `beta` label.

#### Scenario: First beta for a minor release
- **WHEN** maintainers prepare the first beta for the next `0.12.0` release
- **THEN** the package version uses a prerelease version such as `0.12.0-beta.sha-a1b2c3d`

#### Scenario: Iterating on beta feedback
- **WHEN** maintainers publish a follow-up beta after fixes
- **THEN** the package version uses the new source commit short hash, such as `0.12.0-beta.sha-e4f5g6h`

### Requirement: Stable promotion uses stable semver
The release process SHALL promote a beta-tested change by publishing a stable semver version to the npm `latest` dist-tag.

#### Scenario: Promoting a tested beta
- **WHEN** maintainers determine that the beta build is stable enough for general use
- **THEN** they publish the corresponding stable version such as `0.12.0` to the npm `latest` dist-tag
- **AND** the stable channel does not point to a prerelease version such as `0.12.0-beta.sha-a1b2c3d`

### Requirement: Users can move between channels
The documentation SHALL explain how users install the beta channel and return to the stable channel.

#### Scenario: Installing beta globally
- **WHEN** a user wants to try the beta channel
- **THEN** the documentation provides a global install command targeting `oh-my-space@beta`

#### Scenario: Returning to stable globally
- **WHEN** a beta user wants to return to the stable channel
- **THEN** the documentation provides a global install command targeting `oh-my-space@latest`

### Requirement: Maintainers can verify channel state
The release documentation SHALL include a verification step for npm dist-tags after publishing.

#### Scenario: Verifying a beta publish
- **WHEN** maintainers publish a beta version
- **THEN** the release process directs them to inspect npm dist-tags and confirm that `beta` points to the intended prerelease version

#### Scenario: Verifying a stable publish
- **WHEN** maintainers publish a stable version
- **THEN** the release process directs them to inspect npm dist-tags and confirm that `latest` points to the intended stable version
