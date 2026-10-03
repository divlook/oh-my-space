## Purpose

Define fast, isolated, and repeatable black-box test execution for local development, CI validation, and package inspection.

## Requirements

### Requirement: Risk-tiered contract retention
The canonical suite SHALL place each behavior contract at the least expensive layer that exercises its meaningful boundary, SHALL retain every contract whose recorded boundary is `process-integrity-or-recovery` or `production-bundle-wiring` unless it is replaced by an equivalent contract, and SHALL allow any other contract to be consolidated into fewer tests or deleted when the consolidation or deletion is recorded in the inventory's migration records with a stated reason.

#### Scenario: A protected contract is dropped without replacement
- **WHEN** the inventory drops or thins a contract whose boundary is `process-integrity-or-recovery` or `production-bundle-wiring` without a migration record mapping it to an equivalent replacement
- **THEN** the inventory check fails

#### Scenario: A duplicate contract is consolidated
- **WHEN** one replacement test covers several former contracts that asserted the same observable outcomes
- **THEN** a migration record maps every former contract id to the replacement
- **AND** the canonical suite executes the replacement without also retaining redundant coverage of the former contracts

#### Scenario: An over-specified discretionary contract is deleted
- **WHEN** a contract whose boundary is `production-cli-journey` is deleted because its observable outcome is already asserted elsewhere or it pins incidental behavior
- **THEN** a migration record identifies the deleted contract, the deletion reason, and either the covering replacement or the absence of one
- **AND** the inventory check passes and the canonical suite no longer executes the deleted contract

#### Scenario: A decision-boundary contract moves down a layer
- **WHEN** behavior depends only on parsed Git results, validation input, state classification, redaction, formatting, or command planning
- **THEN** it is verified directly without launching the bundled CLI or a real Git process
- **AND** the migration record maps the former contract to its replacement

#### Scenario: Process wiring retains a floor
- **WHEN** the black-box inventory changes
- **THEN** every public command keeps at least one representative journey through the production bundle

### Requirement: Bounded black-box budget
The test inventory SHALL declare a maximum number of black-box contracts, and the inventory check SHALL fail when the number of registered black-box contracts exceeds that declared maximum. Changing the declared maximum is a reviewed data change and SHALL NOT require a specification change.

#### Scenario: The budget is exceeded
- **WHEN** a change adds a black-box contract while the registered black-box count already equals the declared maximum
- **THEN** the inventory check fails until a contract is consolidated, moved down a layer, deleted, or the declared maximum is raised

#### Scenario: A black-box contract is added within budget
- **WHEN** a change adds a black-box contract while the declared maximum has headroom
- **THEN** the contract registers with a process-boundary rationale as required by the coverage ownership controls
- **AND** the inventory check passes

#### Scenario: The declared maximum is raised
- **WHEN** the declared maximum in the test inventory increases
- **THEN** the specification is unchanged
- **AND** the inventory check enforces the new value from that point on

### Requirement: Canonical full-suite command

The project SHALL provide one canonical `npm test` command that type-checks and builds the production bundle once, executes the complete layered behavior suite, and records verification only after every layer passes against unchanged inputs.

#### Scenario: Complete local or CI verification

- **WHEN** a developer or CI job runs `npm test`
- **THEN** the command type-checks and builds `dist/oms.js`
- **AND** it executes the complete unit, shallow integration, and black-box inventories exactly once
- **AND** every mapped observable behavior contract is included in at least one layer

#### Scenario: An early layer fails

- **WHEN** type-checking, the build, unit tests, or shallow integration tests fail
- **THEN** later more expensive layers do not start
- **AND** no successful verification record is written

### Requirement: Focused local verification

The project SHALL provide layer-focused and feature-focused commands that reuse the canonical test inventories without qualifying as complete package verification.

#### Scenario: Developer verifies one layer

- **WHEN** a developer runs `test:unit`, `test:integration`, or `test:blackbox`
- **THEN** only that declared layer executes
- **AND** it does not write a complete verification record

#### Scenario: Developer verifies one feature group

- **WHEN** a developer runs a feature command such as `test:sync` or `test:commit`
- **THEN** the mapped tests for that feature execute across the applicable layers
- **AND** those same tests remain part of canonical `npm test`
- **AND** the focused command does not write a complete verification record

### Requirement: Deterministic preparation sharding

The canonical suite SHALL divide expensive preparation contracts into deterministic shards whose combined inventory executes every declared contract exactly once.

#### Scenario: Canonical preparation executes

- **WHEN** the canonical suite reaches preparation contracts
- **THEN** independently owned shards may execute within the configured concurrency bound
- **AND** the union of the shards contains every declared preparation contract exactly once

#### Scenario: A preparation contract is added or moved

- **WHEN** the preparation inventory changes
- **THEN** the shard assignment remains deterministic for unchanged contracts
- **AND** an inventory check fails if a contract is omitted from all shards or assigned to more than one shard

### Requirement: Deterministic external failure simulation

Tests SHALL simulate Git remote failures with local repositories or injected process failures and SHALL NOT depend on DNS, proxy, credential, or public network behavior.

#### Scenario: A remote operation must fail

- **WHEN** a test verifies handling of an unavailable, unauthorized, or malformed remote operation
- **THEN** the failure is produced by a deterministic local repository or injected Git-process response
- **AND** the result does not depend on resolving or contacting an external hostname

#### Scenario: Network access is unavailable

- **WHEN** the canonical suite runs in an environment without external network access
- **THEN** all remote-failure contracts produce the same exit status and observable diagnostics as a network-enabled run

### Requirement: Expensive coverage ownership controls

The project SHALL maintain a machine-checkable inventory that assigns each behavior contract to its least expensive sufficient test layer and records a process-boundary rationale for every black-box contract.

#### Scenario: A black-box contract is added

- **WHEN** a change adds a bundled-CLI black-box contract
- **THEN** the inventory identifies the observable process-boundary behavior that cannot be sufficiently verified in a cheaper layer
- **AND** the inventory check fails when that rationale or layer assignment is absent

#### Scenario: A contract moves to a cheaper layer

- **WHEN** a unit or shallow integration test replaces a black-box contract
- **THEN** the inventory maps the prior contract to its replacement coverage
- **AND** the canonical suite executes the replacement without also retaining redundant black-box coverage

### Requirement: Bounded parallel test execution

Real-Git integration and black-box tests SHALL run with an explicit finite concurrency selected by repeatable comparison of candidate values on the documented performance environment.

#### Scenario: Candidate concurrency is benchmarked

- **WHEN** candidate concurrency values are measured with warm dependencies on the same documented Node 24 environment
- **THEN** the stable value with the lower median canonical-suite duration is selected
- **AND** the selected value and benchmark evidence are recorded rather than derived from host capacity at runtime

#### Scenario: Expensive test groups execute

- **WHEN** the canonical suite reaches real-Git integration or black-box work
- **THEN** independent fixture owners may execute concurrently up to the selected limit
- **AND** no test observes mutable state owned by another test or journey

### Requirement: Isolated and disposable Git fixtures

Every mutable Git fixture SHALL be owned by one test or one explicitly defined end-to-end journey. Tests may share state only inside the same journey, and file-owned temporary roots SHALL be removed in a batched cleanup unless retention is explicitly requested.

#### Scenario: Tests execute concurrently

- **WHEN** independent tests or journeys modify refs, indexes, configuration, worktrees, or bare push targets
- **THEN** each modification affects only its owner
- **AND** no owner observes mutable state created by another

#### Scenario: Contracts share a journey

- **WHEN** several command contracts form one declared lifecycle, change-propagation, or branch-management journey
- **THEN** they may reuse that journey's repository state in a defined order
- **AND** another journey uses a separate fixture

#### Scenario: A local run completes

- **WHEN** a test file finishes and fixture retention is not enabled
- **THEN** its temporary root and contained repositories are removed in one cleanup

### Requirement: Risk-bounded black-box inventory

The black-box layer SHALL contain only representative bundled-CLI wiring, end-to-end user journeys, process-boundary integrity failures, and representative recovery behavior, with a machine-checked inventory that prevents unreviewed growth.

#### Scenario: Public command wiring is verified

- **WHEN** the black-box inventory executes
- **THEN** every public command has at least one representative path through the production bundle
- **AND** non-process-material decisions are verified in a cheaper layer

#### Scenario: Core user journeys are verified

- **WHEN** the black-box inventory executes
- **THEN** it covers workspace lifecycle, change propagation, and branch management in independently owned journeys
- **AND** remote behavior uses local repositories rather than a live network

#### Scenario: The black-box inventory changes

- **WHEN** a change adds or retains an expensive black-box contract
- **THEN** the inventory check requires an explicit process-boundary rationale
- **AND** the canonical suite fails verification when an untracked black-box contract bypasses that control

#### Scenario: Performance requires a narrower process boundary

- **WHEN** fixture and scheduling optimization still cannot satisfy the performance contract
- **THEN** non-destructive command wiring moves to internal integration before high-risk data-integrity coverage is reduced
- **AND** any state transition moved out of real Git remains covered in a lower layer

### Requirement: Root transaction recovery coverage

Every root transaction crash stage SHALL initially be covered by direct integration against a real Git repository and filesystem, while at least one representative recovery flow SHALL execute through the bundled CLI.

#### Scenario: A crash-stage transition is verified

- **WHEN** the suite exercises a root transaction interruption point
- **THEN** it checks the preserved index, ref, lock, artifact, and recovery-marker state against a real repository

#### Scenario: Performance remains above the hard target

- **WHEN** all lower-risk process boundaries have been reduced and the suite still exceeds the acceptance limit
- **THEN** representative real-Git crash stages remain
- **AND** the remaining crash-state transitions continue through deterministic injected tests

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
The completed change SHALL demonstrate the local and CI performance contracts with repeatable external measurements rather than machine-sensitive assertions in the functional suite. The post-migration acceptance budgets are: a local median of no more than 110 seconds with no run exceeding 135 seconds, and a CI Test step of no more than 55 seconds per matrix entry.

The three-run `post-migration` benchmark on Node v24.19.0 measured 97.029 s, 101.869 s, and 98.237 s (median 98.237 s, max 101.869 s); the final `npm test` run completed in 126.12 s. The CI limit includes margin over the latest available workflow Test-step durations before this change (48 s on Node 20.19.0 and 39 s on Node 24; [CI run 32482147336](https://github.com/divlook/oh-my-space/actions/runs/32482147336)).

#### Scenario: Local performance is accepted
- **WHEN** three complete `npm test` runs execute on the arm64 macOS workstation with `.nvmrc` Node 24 and warm dependencies
- **THEN** the median duration including type-check and build is no more than 110 seconds
- **AND** no run exceeds 135 seconds

#### Scenario: CI performance is accepted
- **WHEN** cache-miss CI jobs execute the complete suite on Node 20.19 and the `.nvmrc` Node 24 runtime
- **THEN** each matrix entry's Test step completes in no more than 55 seconds

#### Scenario: Latest supported runtime is diagnosed
- **WHEN** the project evaluates the latest supported Node runtime
- **THEN** a diagnostic benchmark records the runtime identity and complete-suite duration
- **AND** a catastrophic runtime-specific slowdown is reported without replacing the Node 20 or Node 24 acceptance budgets

#### Scenario: Functional tests execute normally
- **WHEN** the canonical suite runs outside performance acceptance measurement
- **THEN** functional pass or failure does not depend on a machine-sensitive wall-clock assertion

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
