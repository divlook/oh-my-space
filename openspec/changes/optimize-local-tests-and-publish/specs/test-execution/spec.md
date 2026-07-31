## MODIFIED Requirements

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

### Requirement: Behavior-preserving layered coverage
The canonical suite SHALL preserve every observable behavior contract represented by the 295-case baseline while assigning each contract to the least expensive layer that exercises its meaningful boundary.

#### Scenario: A pure decision contract is migrated
- **WHEN** a behavior depends only on parsed Git results, validation input, state classification, redaction, formatting, or command planning
- **THEN** it is verified directly without launching the bundled CLI or a real Git process

#### Scenario: A filesystem or lightweight Git contract is migrated
- **WHEN** behavior depends on real file semantics or lightweight Git initialization, configuration, or status
- **THEN** it is verified in a shallow integration test using an owned disposable fixture

#### Scenario: A process boundary is material
- **WHEN** behavior depends on bundled CLI wiring, a representative end-to-end journey, or data-integrity behavior across real Git operations
- **THEN** it remains in the bounded black-box layer

### Requirement: Explicit contract migration evidence
The change SHALL map every baseline test name to its replacement test or tests and SHALL retain that reconciliation in verification evidence.

#### Scenario: Several baseline cases are consolidated
- **WHEN** one replacement test covers several former cases
- **THEN** the mapping identifies every former case
- **AND** the replacement asserts every former observable outcome

#### Scenario: Migration is accepted
- **WHEN** the layered suite is ready for final verification
- **THEN** all 295 baseline names have at least one replacement mapping
- **AND** no behavior contract was removed solely to meet the performance target

### Requirement: Bounded parallel test execution
Real-Git integration and black-box tests SHALL run with an explicit finite concurrency selected by repeatable comparison of candidate values two and four.

#### Scenario: Candidate concurrency is benchmarked
- **WHEN** concurrency two and four are measured on the same environment with warm dependencies
- **THEN** the stable value with the lower median is selected
- **AND** the selected value is explicit rather than host-dependent

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
The black-box layer SHALL begin with approximately 25–35 cases covering every public command's bundled wiring, three isolated user journeys, data-integrity failures whose process boundary is material, and one representative CLI recovery flow.

#### Scenario: Public command wiring is verified
- **WHEN** the black-box inventory executes
- **THEN** every public command has at least one path through `dist/oms.js`

#### Scenario: Core user journeys are verified
- **WHEN** the black-box inventory executes
- **THEN** it covers workspace lifecycle, change propagation, and branch management in three independently owned journeys
- **AND** remote behavior uses local `file://` bare repositories rather than a live network

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

### Requirement: Test execution performance evidence
The completed change SHALL demonstrate the local and CI performance contracts without embedding wall-clock assertions in the functional suite.

#### Scenario: Local performance is accepted
- **WHEN** three complete `npm test` runs execute on the documented M2 Mac with `.nvmrc` Node 24 and warm dependencies
- **THEN** the median duration including type-check and build is no more than 60 seconds
- **AND** no run exceeds 75 seconds

#### Scenario: CI performance is accepted
- **WHEN** cache-miss CI jobs execute the complete suite on Node 20.19 and the `.nvmrc` Node 24 runtime
- **THEN** each matrix entry's Test step completes in no more than 60 seconds

#### Scenario: Functional tests execute normally
- **WHEN** the canonical suite runs outside performance acceptance measurement
- **THEN** functional pass or failure does not depend on a machine-sensitive wall-clock assertion
