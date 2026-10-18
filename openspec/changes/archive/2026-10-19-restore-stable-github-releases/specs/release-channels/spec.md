# Spec Delta

## ADDED Requirements

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

## MODIFIED Requirements

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
