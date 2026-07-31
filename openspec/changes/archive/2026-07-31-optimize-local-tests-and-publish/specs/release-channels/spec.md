## ADDED Requirements

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
