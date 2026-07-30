## Purpose

Define fast, isolated, and repeatable black-box test execution for local development, CI validation, and package inspection.

## Requirements

### Requirement: Canonical full-suite command
The project SHALL provide one canonical full-suite command that builds the CLI once and executes every black-box test against the resulting `dist/oms.js` bundle.

#### Scenario: Complete local or CI verification
- **WHEN** a developer or CI job runs `npm test`
- **THEN** the command type-checks and builds the bundle before executing the tests
- **AND** every test file in the full black-box suite is included exactly once

### Requirement: Focused local verification
The project SHALL provide documented commands for running stable feature-oriented subsets of the black-box suite without defining a separate test inventory.

#### Scenario: Developer verifies one feature group
- **WHEN** a developer runs a focused test command after building the bundle
- **THEN** only the selected feature group's test files execute
- **AND** those same files remain part of the canonical full suite

### Requirement: Bounded parallel test execution
The full black-box suite SHALL be organized into independent files and run with an explicit finite concurrency limit selected from repeatable benchmarks.

#### Scenario: Full suite uses multiple workers safely
- **WHEN** the canonical full suite runs on a machine with parallel capacity
- **THEN** independent test files may execute concurrently up to the configured limit
- **AND** no test depends on execution order or mutable state owned by another worker

#### Scenario: Concurrency is tuned for Git-heavy work
- **WHEN** candidate concurrency values are benchmarked on the same environment
- **THEN** the project selects the stable value with the lower median duration
- **AND** the selected value is explicit rather than relying on host-dependent default concurrency

### Requirement: Isolated and disposable Git fixtures
Every writable Git fixture SHALL be owned by one test, and temporary repositories SHALL be removed in a batched cleanup after their owning test file completes unless fixture retention is explicitly requested for debugging.

#### Scenario: Concurrent tests mutate repositories
- **WHEN** two tests modify refs, indexes, configuration, worktrees, or bare push targets concurrently
- **THEN** each modification affects only the owning test's repository
- **AND** neither test observes state created by the other

#### Scenario: Local test run completes normally
- **WHEN** a test file finishes and fixture retention is not enabled
- **THEN** its worker-owned temporary root and contained repositories are removed

### Requirement: Immutable fixture templates
If reusable Git templates are introduced to meet the performance target, the templates SHALL remain immutable and each consuming test SHALL receive an isolated local clone before mutation.

#### Scenario: One cloned fixture is mutated
- **WHEN** a test changes refs or configuration in a clone derived from a reusable template
- **THEN** the template remains unchanged
- **AND** a second clone does not observe the first clone's mutable state

### Requirement: Non-duplicative CI package inspection
Each CI validation job SHALL execute the canonical full suite at most once before inspecting the npm package contents, while real package and publish flows SHALL retain the `prepack` test gate.

#### Scenario: CI inspects package contents after tests
- **WHEN** `npm test` has passed in a CI or release validation job
- **THEN** the subsequent `npm pack --dry-run` inspection does not execute npm lifecycle scripts
- **AND** the package file list is still produced and inspected from the built workspace

#### Scenario: A real package or publish flow runs
- **WHEN** npm executes the normal package or publish lifecycle without the CI inspection bypass
- **THEN** `prepack` invokes the canonical full test gate before an artifact is produced or published

### Requirement: Test execution performance evidence
The change SHALL record comparable before-and-after measurements and demonstrate at least a 40 percent reduction in both the local full-suite median and the cumulative CI `Test` plus `Pack dry run` duration.

#### Scenario: Local performance is evaluated
- **WHEN** the implementation is ready for acceptance
- **THEN** baseline and optimized measurements use the same machine, Node version, warm dependency state, and three complete runs
- **AND** the optimized three-run median is no more than 60 percent of the baseline median

#### Scenario: CI performance is evaluated
- **WHEN** an optimized CI run completes
- **THEN** its cumulative `Test` plus `Pack dry run` step duration is compared with a representative baseline run on the same Node matrix entry
- **AND** the optimized cumulative duration is no more than 60 percent of the baseline duration

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
