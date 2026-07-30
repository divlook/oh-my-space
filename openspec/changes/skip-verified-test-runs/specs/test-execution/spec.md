## ADDED Requirements

### Requirement: Single-trigger CI validation
CI validation SHALL be triggered by pull request events only, and a superseded run for the same ref SHALL be cancelled rather than allowed to complete.

#### Scenario: A commit is pushed to a pull request branch
- **WHEN** a commit is pushed to a branch with an open pull request
- **THEN** exactly one CI workflow run is created for that pull request
- **AND** no second run is created for the same head commit by a branch push trigger

#### Scenario: A branch has no open pull request
- **WHEN** a commit is pushed to a branch with no open pull request
- **THEN** no CI workflow run is created
- **AND** opening a pull request for that branch creates the run

#### Scenario: A newer commit supersedes a running validation
- **WHEN** a new commit is pushed while a CI run for the same pull request is still in progress
- **THEN** the in-progress run is cancelled
- **AND** only the run for the newest commit continues

### Requirement: Fail-safe content fingerprint
CI SHALL derive a content fingerprint from every tracked file in the checked-out tree except paths named in an explicitly declared exclusion list, so that any path not named in that list contributes to the fingerprint by default.

#### Scenario: A new source path is introduced
- **WHEN** a commit adds a tracked file under a path absent from the exclusion list
- **THEN** the fingerprint changes
- **AND** the canonical full suite executes for that content

#### Scenario: Only excluded paths change
- **WHEN** a commit changes only paths named in the exclusion list
- **THEN** the fingerprint is unchanged from the previously verified content

#### Scenario: A test-relevant document changes
- **WHEN** a commit changes a file whose content the test suite asserts on, such as a published skill document
- **THEN** that file contributes to the fingerprint
- **AND** the fingerprint changes

### Requirement: Complete verification key
The verification key SHALL combine the content fingerprint with every outcome-affecting variable that does not live in the tree, and SHALL be matched only on exact equality.

#### Scenario: Matrix entries do not vouch for each other
- **WHEN** one matrix entry has verified a fingerprint
- **THEN** a matrix entry with a different resolved runtime version or runner platform does not treat that fingerprint as verified

#### Scenario: The resolved runtime changes without a tree change
- **WHEN** the pinned runtime file resolves to a different patch version than the version recorded in an existing marker
- **THEN** the key does not match
- **AND** the canonical full suite executes

#### Scenario: A near-miss key is present
- **WHEN** a marker exists whose key shares a prefix with the current key but is not equal to it
- **THEN** the lookup reports a miss
- **AND** the canonical full suite executes

### Requirement: Verification memoization
A CI validation job SHALL skip the build, dependency install, canonical full suite, and package inspection steps when an exact verification key match exists, SHALL execute them otherwise, and SHALL record a marker under that key only after those steps pass.

#### Scenario: Content has not been verified
- **WHEN** no marker matches the verification key
- **THEN** the job installs dependencies, runs the canonical full suite, and inspects the package contents
- **AND** a marker is recorded under that key after those steps pass

#### Scenario: Content has already been verified
- **WHEN** a marker matches the verification key
- **THEN** the job does not install dependencies, run the suite, or inspect the package contents

#### Scenario: Verification fails
- **WHEN** the canonical full suite fails
- **THEN** no marker is recorded for that key
- **AND** a later run for the same content executes the suite again

#### Scenario: The marker store loses an entry
- **WHEN** a previously recorded marker is no longer retrievable
- **THEN** the lookup reports a miss
- **AND** the canonical full suite executes

### Requirement: Skips preserve the reported status check
A CI validation job SHALL run and report its result on every triggering event, including when it skips verification work, and CI SHALL NOT achieve skipping by filtering the workflow on changed paths.

#### Scenario: A job skips verification work
- **WHEN** a validation job skips its verification steps because the content is already verified
- **THEN** the job still runs and reports a successful conclusion
- **AND** the status check for that job is reported rather than left pending

#### Scenario: A pull request changes only excluded paths
- **WHEN** a pull request changes only paths that cannot affect test outcomes
- **THEN** the CI workflow still runs and reports its status checks

### Requirement: Auditable skips
A recorded marker SHALL identify the run that verified the content, and a job that skips verification SHALL report that identity in its run summary.

#### Scenario: A reviewer inspects a skipped run
- **WHEN** a validation job skips verification work
- **THEN** its summary names the earlier run that verified the content, the commit that run verified, the resolved runtime version, and the fingerprint

### Requirement: Main content is always verified
Release validation for the default branch SHALL execute the canonical full suite for the content present on that branch, and SHALL NOT treat a pull request's verification as covering it.

#### Scenario: A pull request merges into the default branch
- **WHEN** a merge lands on the default branch
- **THEN** release validation runs the canonical full suite against the resulting content
- **AND** it does so regardless of any marker recorded by the pull request's validation
