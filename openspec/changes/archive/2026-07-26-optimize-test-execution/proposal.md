## Why

The CLI test suite dominates local and CI feedback time because hundreds of black-box cases run serially from one file and repeatedly construct real Git repositories. CI also executes the complete suite again during `npm pack --dry-run`, roughly doubling each validation job without adding coverage.

## What Changes

- Prevent CI package inspection from invoking the `prepack` test gate after the same job has already passed `npm test`, while retaining the gate for real package and publish flows.
- Split the black-box CLI suite into balanced test files with shared helpers so Node can run independent files concurrently with a bounded concurrency level.
- Provide focused local test commands that build once and run a relevant test group without weakening the full `npm test` gate.
- Introduce reusable, isolated Git fixture templates where benchmarking shows they reduce setup time without sharing mutable repository state.
- Add repeatable timing measurements and acceptance thresholds for local and CI execution while preserving the existing behavioral coverage.
- Allow the bundle parity suite to be reorganized without requiring the legacy single-file layout.

## Capabilities

### New Capabilities
- `test-execution`: Defines full-suite, focused-test, bounded-parallelism, fixture-isolation, packaging-validation, and performance-regression requirements for local and CI test execution.

### Modified Capabilities
- `cli-bundle-packaging`: Preserve black-box behavior parity against the built bundle while allowing tests to be split and executed in parallel rather than requiring `tests/cli.test.js` to remain unchanged.

## Impact

- Affected files include `package.json`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, and the test files and helpers under `tests/`.
- The production CLI behavior and published package contents do not change.
- The actual npm `prepack` safety gate remains in place for package and publish flows; only redundant CI dry-run invocation is suppressed after an explicit successful test step.
- No new runtime dependencies are expected. Any test-only dependency or custom runner would require separate justification.
