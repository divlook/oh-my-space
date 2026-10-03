# Spec Delta

## ADDED Requirements

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

## REMOVED Requirements

### Requirement: Behavior-preserving layered coverage
**Reason**: Replaced by risk-tiered contract retention. Preserving every contract from the recorded 295-case baseline is no longer required; decision-boundary contracts move to cheaper layers, and redundant or over-specified discretionary contracts may be consolidated or deleted.
**Migration**: The inventory's migration records remain the durable evidence: every moved, consolidated, or deleted contract is mapped to its replacement, covering contracts, or deletion reason. Protected boundary classes (`process-integrity-or-recovery`, `production-bundle-wiring`) still require equivalent replacement coverage.

### Requirement: Explicit contract migration evidence
**Reason**: This requirement captured a one-time reconciliation of the 295-case pre-change baseline, which is now complete and archived. The ongoing evidence mechanism is the inventory's migration records under risk-tiered contract retention, enforced by the inventory check.
**Migration**: Migration records continue to provide the evidence trail for every contract move, consolidation, and deletion; no separate one-time reconciliation is required for future changes.

## MODIFIED Requirements

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
