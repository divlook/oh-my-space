## ADDED Requirements

### Requirement: Node 24 required CI baseline

Required CI validation SHALL use one Node 24 runtime configured by `.nvmrc`, without a Node 20 required job or duplicate Node 24 matrix entries. The latest-runtime diagnostic SHALL remain separate and non-gating. Required validation SHALL preserve exact verification-key matching and the existing canonical-suite and package-inspection gates.

#### Scenario: Unverified pull request is validated
- **WHEN** a pull request has no exact matching verification marker
- **THEN** the required Node 24 job installs dependencies, executes the complete canonical suite, and inspects the package
- **AND** no Node 20 job or duplicate Node 24 validation job executes

#### Scenario: Latest-runtime diagnostic fails
- **WHEN** the latest-runtime diagnostic reports a runtime-specific failure
- **THEN** that diagnostic does not replace or invalidate a successful required Node 24 result
- **AND** its failure remains visible for investigation

#### Scenario: Node 24 patch version changes
- **WHEN** `.nvmrc` resolves to a different Node 24 patch version
- **THEN** a marker for the previous resolved runtime does not satisfy the new job's verification key

## MODIFIED Requirements

### Requirement: Test execution performance evidence
The completed change SHALL demonstrate the local and CI performance contracts with repeatable external measurements rather than machine-sensitive assertions in the functional suite. The post-migration acceptance budgets are: a local median of no more than 110 seconds with no run exceeding 135 seconds, and a required Node 24 CI Test step of no more than 55 seconds.

The three-run `post-migration` benchmark on Node v24.19.0 measured 97.029 s, 101.869 s, and 98.237 s (median 98.237 s, max 101.869 s); the final `npm test` run completed in 126.12 s. The CI limit includes margin over the latest available workflow Test-step durations before that migration (48 s on Node 20.19.0 and 39 s on Node 24; [CI run 32482147336](https://github.com/divlook/oh-my-space/actions/runs/32482147336)). These Node 20 measurements are historical evidence, not a current support or acceptance requirement.

#### Scenario: Local performance is accepted
- **WHEN** three complete `npm test` runs execute on the arm64 macOS workstation with `.nvmrc` Node 24 and warm dependencies
- **THEN** the median duration including type-check and build is no more than 110 seconds
- **AND** no run exceeds 135 seconds

#### Scenario: CI performance is accepted
- **WHEN** a cache-miss required CI job executes the complete suite on the `.nvmrc` Node 24 runtime
- **THEN** its Test step completes in no more than 55 seconds

#### Scenario: Latest supported runtime is diagnosed
- **WHEN** the project evaluates the latest supported Node runtime
- **THEN** a diagnostic benchmark records the runtime identity and complete-suite duration
- **AND** a catastrophic runtime-specific slowdown is reported without replacing the Node 24 acceptance budget

#### Scenario: Functional tests execute normally
- **WHEN** the canonical suite runs outside performance acceptance measurement
- **THEN** functional pass or failure does not depend on a machine-sensitive wall-clock assertion
