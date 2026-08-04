## Context

See `proposal.md` for motivation. The canonical runner currently builds and compiles once, then runs unit tests, real-Git integration tests at concurrency 4, and the bundled-CLI inventory at concurrency 6. Several large black-box contract owners already use deterministic shard wrappers, but preparation remains a single long-running owner. Some failure contracts still use unreachable HTTPS remotes, making duration sensitive to the host's DNS, proxy, credential, and network configuration.

Performance work must preserve all observable behavior represented by the pre-change inventory. The existing Node 20 and Node 24 budgets remain acceptance gates; measurements on a newer supported runtime are diagnostic because runtime-specific regressions must not silently redefine the established budget environment.

## Goals / Non-Goals

**Goals:**
- Restore margin beneath the existing local and CI budgets through deterministic partitioning and lower-cost test ownership.
- Preserve an auditable mapping from every pre-change contract to retained or replacement coverage.
- Make remote failures and shard membership deterministic across machines.
- Prevent expensive black-box coverage from growing without an explicit process-boundary rationale.
- Produce repeatable Node 24 concurrency and duration evidence plus a diagnostic measurement on the latest supported Node runtime.

**Non-Goals:**
- Changing public CLI behavior, release semantics, or the canonical `npm test` contract.
- Weakening data-integrity or recovery coverage to achieve a timing result.
- Adding wall-clock assertions to functional tests.
- Selecting concurrency dynamically from host CPU count or changing the accepted Node 20 and Node 24 budgets.

## Decisions

### Record the inventory before moving tests

Capture every current contract name, owner, layer, and process-boundary rationale before migration. Maintain a migration map from that immutable baseline to the final owner or owners. A deterministic inventory check will compare discovered tests with the declared final inventory, reject missing or duplicate shard membership, and reject black-box entries without a rationale.

This makes coverage preservation reviewable and avoids treating the final test count as a proxy for behavior coverage. A lower-level replacement may consolidate cases only when the map identifies every former contract and the replacement asserts each observable outcome.

### Stabilize preparation first with explicit shards

Split preparation contracts behind the same environment-selected shard pattern already used by branch, branch-list, commit, and sync owners. Each thin entry point selects one stable shard and imports a shared contract module. Shard assignment will be deterministic and exhaustively checked, rather than relying on declaration order accidentally observed by concurrent workers.

Choose shard boundaries using measured owner duration and fixture ownership, not equal test counts. Shards may run concurrently only when they do not share mutable repositories, temporary roots, environment mutation, or process stubs.

### Replace external failure timing with local boundaries

Use disposable local bare repositories for genuine remote Git semantics. Use an injected or PATH-scoped Git process stub when the contract concerns a specific command failure, stderr payload, redaction, retry, or exit status. Keep example HTTPS URLs only as inert data when parsing or redaction is the behavior under test; no test may require resolving or contacting those hosts.

This preserves the failure surface while removing DNS, proxy, credential-helper, and network timeout variance.

### Move contracts to the least expensive meaningful layer

Classify every black-box contract by the boundary it proves:

- Pure parsing, validation, classification, redaction, formatting, and command-planning decisions move to unit tests.
- File semantics and lightweight Git initialization, configuration, status, and deterministic command failures move to shallow integration tests with owned disposable fixtures.
- Representative production-bundle wiring, end-to-end journeys, and integrity or recovery behavior whose process boundary is material remain black-box tests.

Extract production decision seams where necessary rather than duplicating logic in tests. Keep one representative bundled path per public command and preserve independently owned workspace lifecycle, change propagation, and branch-management journeys. Remove a migrated black-box case only after its replacement and migration-map entry exist.

### Keep concurrency explicit and evidence-based

Benchmark plausible finite concurrency values on the documented M2 with `.nvmrc` Node 24, warm dependencies, and unchanged suite inputs. Run complete canonical-suite samples for each candidate, compare medians, retain per-run durations, and select the stable lower-median value with adequate margin below the hard limit. Record the chosen integration and black-box limits in the runner; do not derive them from host capacity.

Rebalance owners before increasing concurrency. Higher concurrency that raises variance or causes fixture interference is rejected even if one run is faster.

### Separate acceptance budgets from runtime diagnostics

Retain the three-run local Node 24 acceptance procedure and the cache-miss Node 20/Node 24 CI gates. Add a latest-supported-Node diagnostic benchmark that records the exact runtime and complete-suite duration and reports a material slowdown without making that runtime the source of the established acceptance threshold.

Functional suite success remains behavior-only. Performance evidence is produced by the benchmark procedure and CI step timing, not by assertions inside tests.

### Enforce ownership and growth in the canonical path

Run the deterministic inventory validation as part of canonical verification before expensive layers. The check covers declared layer ownership, shard completeness, duplicate assignment, and black-box rationale. Focused commands reuse the same inventories so they cannot drift from `npm test`.

The control is repository-local and deterministic; it introduces no service or runtime dependency.

## Risks / Trade-offs

- **Migration can accidentally weaken assertions.** Require the baseline map and review replacement assertions before deleting the original black-box case.
- **Shard setup can duplicate expensive fixture work.** Partition by independent fixture owner and measure complete-suite duration, not isolated test counts.
- **Process stubs can diverge from real Git behavior.** Use local real repositories whenever Git semantics matter; reserve stubs for controlled process responses and retain representative real-Git paths.
- **Inventory metadata can become maintenance overhead.** Keep one canonical machine-readable source and generate or validate derived views rather than maintaining parallel lists.
- **A concurrency choice can be machine-specific.** Select on the documented acceptance environment, retain raw measurements, and prefer the lower-variance candidate when medians are close.
- **A diagnostic latest runtime may be mistaken for a gate.** Label it non-gating and report it separately from the Node 20 and Node 24 acceptance results.
