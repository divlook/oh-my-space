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

### Requirement: Beta publishing is reproducible
The beta publishing process SHALL prevent public beta artifacts from including uncommitted local changes.

#### Scenario: Dirty working tree override is limited to dry-runs
- **WHEN** maintainers request a beta publish with dirty working tree override enabled
- **THEN** the release process rejects the publish before creating a package artifact

### Requirement: Deterministic beta verification equivalence

The beta publisher SHALL treat stable and beta-prepared package metadata as the same logical test input only when the beta version is derived from the current HEAD and only the three designated version fields differ.

#### Scenario: Publisher prepares the expected beta version

- **WHEN** the beta publisher changes `package.json.version`, `package-lock.json.version`, and `package-lock.json.packages[""].version` to `<base>-beta.sha-<current HEAD short hash>`
- **AND** every other test-relevant input is unchanged
- **THEN** a matching stable-metadata verification record may cover the logical source inputs

#### Scenario: Another package field changes

- **WHEN** beta preparation changes any additional test-relevant package or lockfile field
- **THEN** the previous verification record does not match
- **AND** the complete canonical suite executes before packaging

#### Scenario: Prerelease version is not the expected HEAD-derived value

- **WHEN** package metadata contains another prerelease version
- **THEN** the publisher does not normalize that version for verification reuse

### Requirement: Beta artifacts remain freshly verified

A beta dry-run or publish that reuses a logical source verification SHALL still rebuild the bundle under the exact beta metadata and verify executable and package version parity before creating or publishing the artifact.

#### Scenario: Beta dry-run reuses source verification

- **WHEN** an exact logical verification record exists for unchanged source inputs
- **THEN** the dry-run skips the complete suite
- **AND** it rebuilds and verifies the expected beta version before inspecting the package

#### Scenario: Publish follows a matching dry-run

- **WHEN** a beta dry-run completed and source, environment, commit, and expected beta version remain unchanged
- **THEN** the subsequent publish may reuse the complete suite result
- **AND** it repeats the fresh build and beta artifact version checks

#### Scenario: Beta artifact version check fails

- **WHEN** the rebuilt CLI or package metadata does not equal the expected beta version
- **THEN** dry-run or publication stops
- **AND** the matching local verification record is invalidated
