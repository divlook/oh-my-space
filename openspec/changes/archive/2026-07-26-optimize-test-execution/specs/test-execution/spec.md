## ADDED Requirements

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
