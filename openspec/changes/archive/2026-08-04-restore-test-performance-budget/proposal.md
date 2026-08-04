## Why

The canonical suite has regressed from a 55.24-second local median to 72.62 seconds on the documented M2/Node 24 environment, leaving almost no margin below the 75-second limit. The prior optimization retained every expensive bundled-CLI contract and depended on scheduling, so 35 additional black-box cases, a 47.8-second unsharded preparation file, and severe Node 25 slowdown exposed a structural performance problem rather than a one-off tuning issue.

## What Changes

- Restore the existing performance budget immediately by deterministically sharding the preparation contracts, rebalancing expensive black-box owners, and re-benchmarking bounded concurrency on the documented Node 24 environment.
- Replace live `https://*.invalid` Git failure paths with deterministic local or injected failures so the canonical suite never depends on DNS, proxy, credential, or network timeout behavior.
- Complete the originally planned layered migration: keep only representative bundled-CLI journeys and process-boundary integrity cases in the black-box layer, and move non-process-material decisions and lightweight Git/filesystem behavior to unit or shallow integration tests.
- Preserve every observable contract through an explicit before/after inventory and migration map; performance work must not delete behavior coverage.
- Add durable regression controls for black-box inventory growth, per-layer ownership, and repeatable performance measurements so new expensive coverage requires an explicit process-boundary rationale.
- Continue enforcing the existing Node 20 and Node 24 CI budgets, and add a latest-supported-Node diagnostic benchmark that catches catastrophic runtime-specific slowdowns before they become the default local experience.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `test-execution`: Strengthen the existing layered-test, deterministic-remote, bounded-concurrency, black-box inventory, and performance-evidence requirements with durable regression controls and supported-runtime diagnostics.

## Impact

- Affected test infrastructure: `scripts/test.mjs`, `scripts/run-test-layer.mjs`, test compilation, deterministic shard entry points, and shared fixtures.
- Affected inventories: preparation, branch, branch-list, commit, sync, scaffold, and tools contracts under `tests/`, plus unit and shallow integration replacements.
- Affected automation: CI performance evidence and any diagnostic latest-supported-Node job or report; release and prepack verification semantics remain unchanged.
- No public CLI behavior, workspace data, package API, or command contract changes are intended.
