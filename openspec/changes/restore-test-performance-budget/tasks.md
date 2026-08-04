## 1. Baseline and Ownership Evidence

- [x] 1.1 Capture the pre-change test inventory with each contract name, current owner, layer, and measured owner duration.
- [x] 1.2 Classify every current black-box contract by its meaningful boundary and record the retained owner or planned lower-layer replacement.
- [x] 1.3 Add the migration map that reconciles every pre-change contract with one or more retained or replacement tests.

## 2. Deterministic Expensive Execution

- [x] 2.1 Convert preparation tests to a shared contract module with independently runnable deterministic shard entry points.
- [x] 2.2 Rebalance preparation and existing black-box shard boundaries by measured duration and fixture ownership without changing assertions.
- [x] 2.3 Add shard inventory checks that reject omitted contracts, duplicate membership, and unstable assignment.
- [x] 2.4 Replace remote-failure tests that contact `https://*.invalid` with local bare repositories or PATH-scoped Git failure stubs while preserving exit-status and diagnostic assertions.
- [x] 2.5 Run the preparation, branch, branch-list, commit, sync, scaffold, and tools focused commands to confirm deterministic behavior after the shard and failure-path changes.

## 3. Layered Contract Migration

- [x] 3.1 Move pure parsing, validation, classification, redaction, formatting, and command-planning contracts from bundled-CLI tests to unit tests.
- [x] 3.2 Move file semantics and lightweight Git initialization, configuration, status, and controlled process-failure contracts to owned shallow integration fixtures.
- [x] 3.3 Retain representative production-bundle wiring for every public command and the independently owned workspace lifecycle, change propagation, and branch-management journeys.
- [x] 3.4 Retain process-material data-integrity and recovery coverage, including representative bundled recovery and real-Git crash-state paths.
- [x] 3.5 Remove redundant black-box cases only after their replacements pass and their migration-map entries identify every preserved observable outcome.

## 4. Regression Controls

- [x] 4.1 Add one machine-readable final inventory with layer ownership, shard membership, and process-boundary rationale for every black-box contract.
- [x] 4.2 Add deterministic validation that compares discovered tests with the inventory and rejects missing owners, duplicate shard assignments, and unrationalized black-box growth.
- [x] 4.3 Run inventory validation in canonical verification before expensive layers and make focused commands consume the same declared inventories.
- [x] 4.4 Add contract-level tests for inventory validation failures and successful deterministic shard reconciliation.

## 5. Concurrency and Runtime Evidence

- [x] 5.1 Benchmark candidate integration and black-box concurrency values with unchanged inputs and warm dependencies on the documented M2 and `.nvmrc` Node 24 environment.
- [x] 5.2 Record all candidate durations and select explicit finite limits using median duration and variance, preferring fixture safety when results are close.
- [x] 5.3 Update the canonical runner with the selected explicit limits and confirm focused layer commands use matching limits.
- [x] 5.4 Add a non-gating latest-supported-Node diagnostic benchmark that reports the exact runtime and complete-suite duration separately from Node 20 and Node 24 acceptance gates.

## 6. Final Verification

- [x] 6.1 Confirm the migration map covers every pre-change contract and every final black-box contract has a process-boundary rationale.
- [x] 6.2 Run the canonical suite on Node 20.19 and `.nvmrc` Node 24 and confirm functional results do not depend on wall-clock assertions.
- [x] 6.3 Run three complete warm-dependency `npm test` measurements on the documented M2 and Node 24 environment, confirming a median at or below 60 seconds and no run above 75 seconds.
- [ ] 6.4 Verify cache-miss Node 20 and Node 24 CI Test steps complete within 60 seconds and retain the run evidence.
- [x] 6.5 Run the latest-supported-Node diagnostic benchmark and retain its runtime identity and duration with the acceptance evidence.
