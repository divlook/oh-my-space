## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Explicit contract migration evidence
The change SHALL map every test in the recorded pre-change inventory to its retained or replacement test or tests and SHALL retain that reconciliation in verification evidence.

#### Scenario: Several baseline cases are consolidated
- **WHEN** one replacement test covers several former cases
- **THEN** the mapping identifies every former case
- **AND** the replacement asserts every former observable outcome

#### Scenario: Migration is accepted
- **WHEN** the layered suite is ready for final verification
- **THEN** every name in the recorded pre-change inventory has at least one retained or replacement mapping
- **AND** no behavior contract was removed solely to meet the performance target

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

### Requirement: Test execution performance evidence
The completed change SHALL demonstrate the local and CI performance contracts with repeatable external measurements rather than machine-sensitive assertions in the functional suite.

#### Scenario: Local performance is accepted
- **WHEN** three complete `npm test` runs execute on the documented M2 Mac with `.nvmrc` Node 24 and warm dependencies
- **THEN** the median duration including type-check and build is no more than 60 seconds
- **AND** no run exceeds 75 seconds

#### Scenario: CI performance is accepted
- **WHEN** cache-miss CI jobs execute the complete suite on Node 20.19 and the `.nvmrc` Node 24 runtime
- **THEN** each matrix entry's Test step completes in no more than 60 seconds

#### Scenario: Latest supported runtime is diagnosed
- **WHEN** the project evaluates the latest supported Node runtime
- **THEN** a diagnostic benchmark records the runtime identity and complete-suite duration
- **AND** a catastrophic runtime-specific slowdown is reported without replacing the Node 20 or Node 24 acceptance budgets

#### Scenario: Functional tests execute normally
- **WHEN** the canonical suite runs outside performance acceptance measurement
- **THEN** functional pass or failure does not depend on a machine-sensitive wall-clock assertion
