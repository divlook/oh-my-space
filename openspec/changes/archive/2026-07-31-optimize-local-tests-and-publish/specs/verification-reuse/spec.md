## ADDED Requirements

### Requirement: Canonical verification record
The project SHALL write a local verification record only after the canonical `npm test` command completes successfully and the test-relevant inputs remain unchanged throughout the run.

#### Scenario: Complete unchanged verification succeeds
- **WHEN** `npm test` passes every canonical phase
- **AND** the post-run content fingerprint equals the pre-run fingerprint
- **THEN** the project records the successful verification key and verification metadata

#### Scenario: Focused verification succeeds
- **WHEN** a developer runs a layer-focused or feature-focused test command
- **THEN** no complete verification record is written

#### Scenario: Inputs change during verification
- **WHEN** `npm test` passes but the test-relevant content changes before it finishes
- **THEN** no verification record is written
- **AND** the command reports that the result cannot cover the changed inputs

#### Scenario: Record persistence fails
- **WHEN** the canonical suite passes but its verification record cannot be written
- **THEN** `npm test` reports a warning and remains successful
- **AND** a later package operation executes the complete suite instead of trusting an absent record

### Requirement: Complete local verification key
A local verification key SHALL combine the test-relevant content fingerprint with the exact Node version, Git version, OS name and version, and CPU architecture, and SHALL match only on exact equality.

#### Scenario: Runtime identity changes
- **WHEN** content is unchanged but any keyed runtime or platform value differs from the recorded value
- **THEN** the verification record does not match
- **AND** the complete suite executes before packaging

#### Scenario: Runtime identity is unchanged
- **WHEN** both content and every keyed runtime or platform value exactly match a valid record
- **THEN** the package lifecycle may reuse the recorded test result

### Requirement: Worktree-local bounded record
The local verification record SHALL be gitignored, excluded from npm package contents, scoped to one worktree, retain only the latest successful key, and have no time-based expiry.

#### Scenario: Another worktree has matching content
- **WHEN** a sibling worktree has the same content and environment but no record of its own
- **THEN** it does not consume the first worktree's record

#### Scenario: The latest record remains unchanged over time
- **WHEN** content and environment still exactly match an older latest record
- **THEN** the record remains eligible for reuse regardless of its age

### Requirement: Shared fail-safe content fingerprint
Local and CI verification SHALL use one dependency-free fingerprint implementation and one exclusion configuration. The fingerprint SHALL include path, content, and mode for all non-excluded tracked inputs and SHALL additionally include relevant untracked local inputs.

#### Scenario: A relevant untracked source exists locally
- **WHEN** an untracked file appears under a test-relevant source, test, or configuration path
- **THEN** that path and content contribute to the local fingerprint

#### Scenario: A generated path changes
- **WHEN** only declared generated output, dependency, or verification-record paths change
- **THEN** the content fingerprint remains unchanged

#### Scenario: A new path is not classified
- **WHEN** a new tracked or relevant untracked path is absent from the explicit exclusion list
- **THEN** the path contributes to the fingerprint by default

#### Scenario: An exclusion is proposed
- **WHEN** maintainers add a path to the common exclusion list
- **THEN** verification evidence demonstrates that the path cannot affect any canonical test outcome

### Requirement: Deterministic verification environment
The canonical suite SHALL remove or replace ambient Node options, external Git configuration, hooks, and other outcome-affecting developer state unless that state is the explicit subject of a compatibility test.

#### Scenario: A developer has global Git hooks or signing configured
- **WHEN** the canonical suite creates and mutates its disposable repositories
- **THEN** those external settings do not change test behavior

#### Scenario: A compatibility case needs external-looking state
- **WHEN** a contract depends on a particular environment or configuration value
- **THEN** the test supplies that value explicitly within its owned process or fixture

### Requirement: Verification-aware package lifecycle
Every direct or scripted `npm pack` and `npm publish` SHALL check the local verification record, reuse only an exact match, and execute the canonical suite on a missing, malformed, mismatched, or force-disabled record.

#### Scenario: Exact verification exists
- **WHEN** prepack finds an exact valid record
- **THEN** it skips the canonical suite only
- **AND** it continues with a fresh build and artifact checks

#### Scenario: Verification is unavailable or uncertain
- **WHEN** the record is absent, malformed, stale, or does not exactly match
- **THEN** prepack executes canonical `npm test`
- **AND** packaging continues only after that command succeeds

#### Scenario: Maintainer forces re-verification
- **WHEN** `OMS_FORCE_TEST=1` is present during pack or publish
- **THEN** prepack ignores any matching record and executes canonical `npm test`

### Requirement: Fresh artifact verification on reuse
A package lifecycle that reuses a test result SHALL always type-check and rebuild the production bundle, execute the resulting CLI, and verify that the CLI version and package metadata version agree before creating or publishing an artifact.

#### Scenario: Generated output is missing or stale
- **WHEN** a matching test record exists but `dist` is missing or differs from current source output
- **THEN** prepack creates a fresh production build before packaging

#### Scenario: Build or artifact verification fails
- **WHEN** the fresh build fails, the CLI cannot execute, or version metadata does not agree
- **THEN** packaging stops
- **AND** the matching verification record is invalidated

#### Scenario: Registry operation fails after local verification
- **WHEN** build and artifact checks pass but the registry rejects or cannot receive the publish
- **THEN** the publish fails
- **AND** the local verification record remains available for a retry against unchanged inputs

### Requirement: Verification invalidation
A new canonical failure for the same key, a package rebuild failure, or an artifact smoke-check failure SHALL invalidate the matching successful record before a later package operation can reuse it.

#### Scenario: Same-key test fails after a prior pass
- **WHEN** canonical `npm test` starts against a matching recorded key and later fails
- **THEN** the prior matching record is removed or made unusable

#### Scenario: Unrelated key fails
- **WHEN** a canonical run for different content or environment fails
- **THEN** it does not create a successful record for that key

### Requirement: Auditable verification reuse
Package operations SHALL report reuse in their normal output and SHALL expose detailed metadata when `OMS_VERIFICATION_VERBOSE=1` is set.

#### Scenario: Default reuse output
- **WHEN** a package operation reuses an exact record without verbose mode
- **THEN** it prints a concise message that canonical tests were reused

#### Scenario: Verbose reuse output
- **WHEN** a package operation reuses a record with `OMS_VERIFICATION_VERBOSE=1`
- **THEN** it reports the verification time, fingerprint, exact Node and Git versions, OS and architecture, and originating verification command
