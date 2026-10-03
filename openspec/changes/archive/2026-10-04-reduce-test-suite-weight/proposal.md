# Proposal

## Why

The canonical `npm test` suite has grown to 376 inventoried contracts, 337 of which (90%) run as black-box tests that spawn the bundled CLI and real Git fixtures per case. Measured on the development machine the full suite takes ~95 s (unit ~3 s, integration ~5 s, blackbox ~87 s), which already exceeds the documented 60 s median / 75 s max budget, and the concurrent fixture owners saturate the CPU while they run. The suite also grew from the recorded 295-case baseline to 376 contracts, and current test-execution requirements forbid removing contracts for performance and demand full baseline preservation, so weight can only be re-homed, never reduced. Test time now exceeds typical edit work time, and the maintainer explicitly accepts coverage risk for over-specified tests to restore fast iteration.

## What Changes

- Replace baseline preservation with risk-tiered coverage: contracts classified as `process-integrity-or-recovery` or `production-bundle-wiring` are protected (they may never be dropped without replacement); all other contracts may be consolidated into fewer tests or deleted, with each consolidation or deletion recorded in the inventory's migration records.
- Move decision-boundary contracts down a layer: assertions that verify parsing, classification, planning, redaction, diagnostics, or JSON shape through the CLI move to unit tests (direct `scripts/lib` calls) or shallow integration tests, asserting the same observable outcomes.
- Consolidate fixture journeys: merge per-case setup in the slowest owners (preparation ~48 s; commit and sync shards ~24–27 s each) into explicitly owned journey walks per feature file, so fixture preparation happens once per journey instead of once per contract.
- Add a hard black-box budget (cap value fixed in design from benchmark evidence) enforced by `validate-test-inventory`, so the growth pattern that produced 295 → 376 contracts cannot repeat unchecked.
- Keep at least one representative production journey per public command plus the existing 13 bundle-wiring contracts; keep the canonical `npm test`, the layer-focused and feature-focused commands, verification memoization, and the prepack test gate unchanged.
- Re-baseline the local and CI performance acceptance numbers after the migration, using measurements produced by the existing benchmark script.
- **BREAKING**: the suite no longer guarantees that every recorded behavior contract from the 295-case baseline survives. Redundant and over-specified contracts may be deleted without a functional replacement. This coverage regression is explicitly accepted.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `test-execution`: replaces the "Behavior-preserving layered coverage" (295-case baseline preservation) and "Explicit contract migration evidence" requirements with a risk-tiered coverage requirement (protected boundary classes; consolidation and deletion allowed when recorded), adds a machine-enforced black-box budget and a cheapest-sufficient-layer policy for newly added tests, and re-baselines the local and CI performance acceptance numbers.

## Impact

- `tests/**` — contract files are consolidated or moved between layers; `helpers.js` gains journey-owned fixture walks; the shard/owner layout may shrink.
- `tests/test-inventory.json`, `scripts/test-inventory-lib.mjs`, `scripts/validate-test-inventory.mjs` — budget enforcement, migration records for consolidations and deletions, boundary schema updates.
- `scripts/run-test-layer.mjs` — owner ordering and concurrency only; may simplify if the shard count drops.
- No production source changes; CI workflow, verification record behavior, and the prepack gate are untouched.
