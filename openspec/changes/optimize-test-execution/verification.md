# Test Execution Verification

## Baseline

- Source revision: `020c094cdc531afedda8a5519ea7cf606c4c4ed8`
- Development Node.js version: `24.11.0` (`.nvmrc` resolves to Node.js 24)
- Baseline inventory: 259 direct `test(...)` declarations in `tests/cli.test.js`, plus three generated workspace-discovery cases.
- Synchronized baseline proof: Release run [30009631669](https://github.com/divlook/oh-my-space/actions/runs/30009631669) passed the full suite and normal package lifecycle at the exact source revision.
- A local baseline attempt was excluded from timing evidence because concurrent iOS simulator tests caused severe resource contention and it exceeded the command timeout.

### Representative CI timings

Run [30017639660](https://github.com/divlook/oh-my-space/actions/runs/30017639660):

| Matrix entry | Test | Pack dry run | Combined |
| --- | ---: | ---: | ---: |
| minimum-supported | 77 s | 71 s | 148 s |
| development | 120 s | 109 s | 229 s |

The exact-revision Release baseline took 91 seconds for `Test` and 90 seconds for `Pack dry run` on the development Node.js version.

The quiet-machine local baseline runs, including the build, were 523.67 seconds, 522.31 seconds, and 523.17 seconds. The median was 523.17 seconds, making the 60 percent acceptance threshold 313.90 seconds.

## Initial grouping

The initial files balance Git-heavy groups against lower-cost command groups:

| File | Main coverage | Expected fixture cost |
| --- | --- | --- |
| `cli-scaffold.test.js` | help, init, validation, doctor | low |
| `cli-sync.test.js` | lifecycle, status, topology, integration | high |
| `cli-commit.test.js` | commit, record, remotes, metadata, recovery | high |
| `cli-branch.test.js` | branch deletion | high |
| `cli-branch-list.test.js` | branch listing and degraded refresh | high |
| `cli-tools.test.js` | agent, legacy guards, update, skills | low |

## Final Results

### Inventory and concurrency

- Final inventory: 263 tests across six feature files (the complete 262-test baseline plus one fixture-template isolation test).
- The sorted baseline test declarations are preserved; the only added test verifies template clone isolation.
- All writable fixtures are created beneath a process-owned temporary root and removed in one exit cleanup. Set `OMS_TEST_RETAIN_FIXTURES=1` to retain the root and print its path.
- Concurrency 2 under the same resource-contention conditions: 521.90 s, 510.54 s, 533.28 s; median 521.90 s.
- Concurrency 4 under the same resource-contention conditions: 533.93 s, 486.34 s, 495.35 s; median 495.35 s.
- Selected concurrency: 4, the stable candidate with the lower median.

The concurrency comparison is valid because both candidates ran on the same machine, Node.js version, warm dependency state, and concurrent simulator workload. These timings are not used for the baseline performance acceptance ratio because that unrelated workload prevented a representative local baseline from completing.

The first optimized runs were 462.71 seconds, 462.92 seconds, and 465.16 seconds, with a median of 462.92 seconds (88.5 percent of baseline). This missed the 60 percent threshold, so fixture setup was profiled and immutable upstream and initialized-workspace templates were introduced. Every test still receives an isolated local clone. Branch deletion and branch listing were also separated after profiling showed that their combined file determined the critical path.

### CI acceptance result

Optimized run [30206174119](https://github.com/divlook/oh-my-space/actions/runs/30206174119) passed both matrix entries:

| Matrix entry | Test | Pack dry run | Combined | Baseline ratio |
| --- | ---: | ---: | ---: | ---: |
| minimum-supported | 39 s | <1 s | 39 s | 26.4% |
| development | 41 s | 1 s | 42 s | 18.3% |

Both combined durations are below 60 percent of their representative baselines (148 seconds and 229 seconds, respectively).

### Local acceptance result

The final post-template runs, including the build, were 295.51 seconds, 303.62 seconds, and 304.02 seconds. The median was 303.62 seconds, or 58.0 percent of the 523.17-second baseline median. This meets the requirement that the optimized median be no more than 60 percent of baseline.

### Compatibility verification

- Node.js 20.19.0: the final 263-test suite passed with concurrency 4; `npm pack --dry-run --ignore-scripts` listed the expected six package files without running tests.
- Node.js 24.11.0: the build passed, the final 263-test suite passed in three complete concurrency-4 runs, and the package dry-run listed the expected six files without running tests.
- A later canonical Node.js 24 run exceeded a 15-minute command limit while unrelated iOS simulator tests heavily saturated the host. This run is excluded because the same built suite had already passed repeatedly and no test failure was reported before external termination.
- Fixture templates are worker-local and immutable. The isolation test mutates a clone's refs and configuration, verifies a sibling clone is unchanged, and verifies a later clone from the template is also unchanged.
- Common branch and metadata fixtures create the same committed submodule topology directly with Git instead of invoking the CLI under test during setup. Dedicated sync tests continue to exercise the production `oms sync` path.
