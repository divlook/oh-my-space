## Why

The canonical suite takes about 350 seconds on the maintainer's M2 Mac while GitHub Actions finishes in under a minute, and `prepack` repeats that full suite even after the same content has already passed `npm test`. This makes local development and beta publishing unnecessarily slow while providing no additional assurance when the tested inputs and execution environment are unchanged.

## What Changes

- Replace the all-black-box test inventory with a layered suite of TypeScript unit tests, shallow integration tests, and a bounded set of real CLI-and-Git journeys while preserving every observable behavior contract.
- Refactor command decision logic into pure functions and inject a small raw Git runner into orchestration code so Git outcomes can be tested without launching thousands of processes.
- Keep `npm test` as the canonical complete gate, add layer-focused and feature-focused commands, and require the full local run to complete within a 60-second median and 75-second worst run on the documented M2/Node 24 benchmark.
- Require both Node 20.19 and Node 24 CI matrix entries to complete the Test step within 60 seconds.
- Record a worktree-local verification marker only after the canonical suite passes against unchanged inputs, keyed by a shared content fingerprint plus the exact Node, Git, OS, and architecture identity.
- Let `prepack` reuse an exact verification record for repository scripts and direct `npm pack`/`npm publish` calls, while falling back to the complete suite on any missing, damaged, stale, or mismatched record.
- Always type-check, rebuild, and smoke-check the executable and package version before packaging, even when the test result is reused.
- Treat only the deterministic beta version fields written by the beta publisher as logically equivalent to the previously tested stable metadata, then rebuild and verify the exact beta version before dry-run or publish.
- Share fail-safe fingerprint calculation and exclusion rules between local verification and CI, including relevant untracked files locally and excluding new paths only after proving they cannot affect test outcomes.
- Preserve an auditable force-reverification path and verbose verification diagnostics through environment variables.

## Capabilities

### New Capabilities

- `verification-reuse`: Content- and environment-bound local verification records, fail-safe package lifecycle reuse, artifact smoke checks, and audit controls.

### Modified Capabilities

- `test-execution`: Restructure the complete black-box inventory into a layered, deterministically sharded suite, formalize focused commands, and add local and CI performance acceptance criteria.
- `cli-bundle-packaging`: Verify behavior through the layered canonical suite and require every package lifecycle to rebuild and smoke-check the self-contained bundle when test results are reused.
- `release-channels`: Define deterministic beta-version fingerprint normalization and reuse between beta dry-run and publish without weakening artifact verification.

## Impact

- Affects `package.json`, test scripts, `prepack`, `scripts/publish-beta.mjs`, the build/test harness, Git and filesystem boundaries under `scripts/lib/`, and both CI and release workflows.
- Retains all 295 existing black-box behavior contracts, adds unit and shallow integration layers, and partitions the four largest inventories into deterministic shards with explicit migration evidence.
- Adds a gitignored, package-excluded, worktree-local verification record and shared dependency-free fingerprint tooling.
- Keeps the public CLI, npm package contents, Node support policy, real publish safety gate, and observable command behavior unchanged.
