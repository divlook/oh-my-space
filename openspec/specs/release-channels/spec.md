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
The release documentation SHALL include verification steps for npm dist-tags after publishing and for the remote version tag, published source commit, and GitHub Release after stable publication, including metadata-only recovery when GitHub completion is missing.

#### Scenario: Verifying a beta publish
- **WHEN** maintainers publish a beta version
- **THEN** the release process directs them to inspect npm dist-tags and confirm that `beta` points to the intended prerelease version

#### Scenario: Verifying a stable publish
- **WHEN** maintainers publish a stable version
- **THEN** the release process directs them to inspect npm dist-tags and confirm that `latest` points to the intended stable version
- **AND** it directs them to verify the remote version tag at the npm source commit and its published, non-prerelease GitHub Release

#### Scenario: Recovering incomplete GitHub metadata
- **WHEN** maintainers find a published npm version without its complete GitHub metadata
- **THEN** the documentation provides a metadata-only recovery procedure and verification steps
- **AND** it explains that npm republication and dist-tag changes are unnecessary

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

### Requirement: Stable publication includes GitHub release metadata
A successful stable release SHALL include a remote `v<version>` Git tag at the npm package's published source commit and a published, non-prerelease GitHub Release for that tag with the corresponding changelog entry. Completion SHALL NOT depend on human-readable package publisher output.

#### Scenario: Publication output changes
- **WHEN** stable npm publication succeeds but its output contains no `New tag:` message
- **THEN** the stable release still completes its remote tag and GitHub Release
- **AND** the release points to the published source commit

#### Scenario: GitHub finalization fails after npm publication
- **WHEN** npm publication succeeds but the remote tag or GitHub Release cannot be completed
- **THEN** the release operation exits unsuccessfully and identifies the incomplete step
- **AND** the npm publication and any completed remote metadata remain intact
- **AND** the diagnostic provides a metadata-only recovery command

### Requirement: Stable metadata recovery verifies publication identity
Metadata-only recovery SHALL verify the requested stable version and source commit against published npm metadata and the package metadata and changelog at that commit before creating remote metadata. It SHALL NOT publish npm packages, change npm dist-tags, or guess a commit when identity evidence is absent or conflicting.

#### Scenario: Recover OMS 2.0.0 and 2.0.1
- **WHEN** a maintainer recovers the missing metadata for version `2.0.0` at `b2a86e8876ac76ffc8e4daed8146f82fe93613d1` and version `2.0.1` at `58af8b34c6d2801ea9900e8ff4275d3c2e70c1d6`
- **THEN** each remote version tag points to that version's published npm source commit
- **AND** each published GitHub Release uses that version's changelog entry
- **AND** npm versions and dist-tags remain unchanged

#### Scenario: Publication cannot be verified
- **WHEN** npm metadata is unavailable, the version is unpublished, the published source commit differs, or the selected commit lacks matching package metadata or release notes
- **THEN** recovery fails before creating remote metadata
- **AND** it reports the missing or conflicting evidence

### Requirement: Stable metadata recovery preserves existing identities
Recovery SHALL create only missing stable release metadata, preserve matching existing tags and published releases, and refuse conflicting remote tags or incompatible existing releases without overwriting or deleting them. A partial completion SHALL be recoverable by repeating the metadata-only operation.

#### Scenario: Tag exists but release is missing
- **WHEN** the remote version tag already resolves to the verified published commit but its GitHub Release is absent
- **THEN** recovery creates the missing Release without moving the tag

#### Scenario: Metadata is already complete
- **WHEN** the remote tag and published stable Release already match the verified version and commit
- **THEN** recovery succeeds without creating duplicates or rewriting the existing release notes

#### Scenario: Existing metadata conflicts
- **WHEN** the remote tag resolves to another commit or its existing Release is draft or prerelease
- **THEN** recovery fails and reports the conflict
- **AND** it leaves that metadata unchanged
