# Skip Verified Test Runs Verification

## Baseline

Pull request #62 is the comparison baseline: four pushes, each producing a `push` run and a `pull_request` run across a two-entry Node matrix, for sixteen job executions. Fingerprints computed with this change's exclusion list show only two distinct test-relevant contents.

| Push | Subject | Fingerprint | Necessary |
| --- | --- | --- | --- |
| `49cc103` | perf(test): optimize black-box test execution | `dceb6f8bcbb8` | yes |
| `0b86395` | docs(openspec): record test execution results | `dceb6f8bcbb8` | no |
| `dcf0956` | chore(openspec): archive optimize test execution | `dceb6f8bcbb8` | no |
| `edf587d` | Merge branch 'main' into optimize-test-execution | `cbda4f05022c` | yes |

Merging `main` in the fourth push brought in content outside the exclusion list, so that push introduced genuinely new content and had to be verified. Four of the sixteen executions were necessary.

## Local fingerprint checks

- Stability: three consecutive invocations on one commit produced `cbda4f05022c2c7b1691162192343f88e94b865b97bc75f13fb4ece154bd1019` each time.
- Sensitivity: `49cc103` and its parent differ (`dceb6f8bcbb8` against `4179ec6c85c6`).
- Exclusion: `dcf0956`, whose diff is confined to `openspec/`, matches its parent exactly.
- Key separation: assembling the key for the same commit under `v20.19.0` and `v24.11.0` produced different keys.

## Platform assumptions verified before implementation

- **Successive pull request runs share a cache scope.** On `feat/add-worktree-mode`, run 29645464757 (2026-07-18) logged `npm cache is not found` and saved a key; runs 29753099953 (2026-07-20) and 29897683946 (2026-07-22) logged `Cache restored from key` for that exact key. All three were `event=pull_request` with `run_attempt=1` and distinct head commits, so they were separate `synchronize` pushes rather than re-runs. No `Release` run occurred between 2026-07-17 and 2026-07-23, so the default-branch scope could not have supplied the key.
- **Cache scopes are isolated per trigger.** One key appears three times in this repository's cache list: `refs/heads/feature/medaka` at 13:00:07, `refs/pull/59/merge` at 13:00:16, and `refs/heads/main` at 13:07:47, with the same pattern for `feature/dottyback` and `refs/pull/60/merge`. `actions/cache` skips saving on an exact hit, so all three runs missed. This is why consolidating triggers is a precondition for memoization, and why `release.yml` cannot consume pull request markers.
- **Path filters cannot serve this purpose.** `pull_request` path filters evaluate a three-dot diff across the whole pull request, so they cannot skip a documentation commit inside a pull request that also changes code. A workflow skipped by a path filter also leaves required checks pending and blocks merging. No path filter is used.
- **A failing suite cannot record a marker.** Steps whose `if` expression contains no status check function keep the implicit `success()`, documented as "A default status check of `success()` is applied unless you include one of these functions." The marker steps therefore do not run once `Test` has failed.

## Results

### Push 1 — `e10fd17`, changes `.github/workflows/ci.yml`

Run [30549264316](https://github.com/divlook/oh-my-space/actions/runs/30549264316), triggered by `pull_request`. Pushing the branch produced no run, and opening the pull request produced exactly one, so no branch-push twin exists.

Both entries logged `Cache not found for input keys`, executed the suite, and saved a marker.

| Entry | Key | Test | Job |
| --- | --- | ---: | ---: |
| minimum-supported | `ci-verified-v1-ubuntu24-X64-nodev20.19.0-1c622268d73f…` | 39 s | 56 s |
| development | `ci-verified-v1-ubuntu24-X64-nodev24.18.0-1c622268d73f…` | 40 s | 55 s |

The two keys share the fingerprint `1c622268d73f…` and differ only in the resolved runtime, confirming that one matrix entry does not vouch for the other. `ImageOS` resolved to `ubuntu24`.

`.nvmrc` pins `24`, which resolved to `v24.18.0` rather than the `v24.11.0` used in the local simulation. Keying on the output of `node -v` rather than the pinned file is therefore load-bearing, not defensive: a marker written under one Node 24 patch release must not vouch for another.

### Push 2 — `d964e1f`, changes only `openspec/`

Run [30549474747](https://github.com/divlook/oh-my-space/actions/runs/30549474747). Both entries logged `Cache restored from key` for the fingerprint `1c622268d73f…` saved by push 1, then skipped `Install dependencies`, `Test`, `Pack dry run`, `Record verification marker`, and `Save verification marker`, and ran `Report reused verification`.

| Entry | Job | Marker restored |
| --- | ---: | ---: |
| minimum-supported | 11 s | 378 B |
| development | 9 s | 382 B |

Both jobs reported `success` rather than a skipped or pending conclusion, so a status check is produced on a hit. The restored marker size confirms the file itself was downloaded: `Report reused verification` reads it with `cat`, which is why `lookup-only: true` was rejected during implementation. The marker is 378-382 bytes, matching the design's "a few hundred bytes".

The jobs fell from 55-56 s to 9-11 s, better than the roughly 15 s the design anticipated.

### Push 3 — `73a6799`, changes `.gitignore`

Run [30549610461](https://github.com/divlook/oh-my-space/actions/runs/30549610461). `.gitignore` is outside the exclusion list, so the fingerprint changed to `87fd18b73dc2…`. Both entries logged `Cache not found for input keys`, executed the suite, and saved a new marker.

| Entry | Key | Test | Job |
| --- | --- | ---: | ---: |
| minimum-supported | `ci-verified-v1-ubuntu24-X64-nodev20.19.0-87fd18b73dc2…` | 38 s | 52 s |
| development | `ci-verified-v1-ubuntu24-X64-nodev24.18.0-87fd18b73dc2…` | 55 s | 75 s |

### One run per push

Three pushes produced three runs, all `event=pull_request`:

| Commit | Event | Conclusion |
| --- | --- | --- |
| `e10fd17` | `pull_request` | success |
| `d964e1f` | `pull_request` | success |
| `73a6799` | `pull_request` | success |

Pushing the branch before the pull request existed produced no run at all, and no push-triggered twin appeared for any commit.

## Comparison with the baseline

Comparing pull request #62's four pushes against the three verification pushes above:

| | Pull request #62 | Pushes 1-3 here |
| --- | ---: | ---: |
| Pushes | 4 | 3 |
| Workflow runs | 8 | 3 |
| Job executions | 16 | 6 |
| Suite executions | 16 | 4 |
| Necessary suite executions | 4 | 4 |
| Redundant suite executions | 12 | 0 |

Every suite execution corresponded to distinct test-relevant content. Documentation-only pushes consumed 9-13 s per entry instead of 55-56 s, and each further documentation-only push on this branch has reused a marker rather than re-running the suite.

## Changeset

No changeset is required. The change is limited to CI configuration and repository hygiene; `oms` behaviour, its published files, and its public interface are unchanged.

## Release validation after the merge

Pull request #63 merged as `a2cb6df`. Release run [30551814453](https://github.com/divlook/oh-my-space/actions/runs/30551814453), triggered by `push` on `main`, completed successfully in 51 s and executed the canonical full suite:

| Step | Duration |
| --- | ---: |
| Install dependencies | 3 s |
| Test | 38 s |
| Pack dry run | 1 s |
| Create release PR or publish | 1 s |

`release.yml` is unchanged and carries no marker steps, so the default-branch content was verified on its own rather than by reusing the pull request's verification. The merge produced no CI run, since CI no longer triggers on `push`.

### Why `release.yml` was left alone

Memoizing the release run is technically possible — caches written on `refs/heads/main` are restorable by later `main` runs — but was measured to be poor value. Across the last eighteen first-parent `main` commits, only 2 of 17 consecutive pairs share a fingerprint, so the hit rate is about 12 percent, further reduced by the seven-day cache eviction given that `main` pushes are typically days apart. Each hit would save roughly 40 s on the one path where a wrong skip is most consequential.

A larger redundancy exists on the publish path: a publishing release run executes the suite twice, once from the explicit `Test` step and once from `prepack` inside `changeset publish`. Run 30018300154 shows this shape. Removing the explicit step would conflict with the `Main content is always verified` requirement, because a `main` push with nothing to publish would then be verified by neither, and direct pushes to `main` are not blocked by the repository ruleset. That trade belongs to its own change.

## Known limitations

- **Markers do not cross pull requests.** They live in the `refs/pull/N/merge` scope, so the first push of every pull request misses even when identical content was verified elsewhere. Base-branch restore does not help, because `release.yml` writes no markers to `main`. The memo accelerates iteration within a pull request, not the first run of one.
- **Branches predating this change still produce a push twin.** For `push` events GitHub reads the workflow file at the pushed commit, so a branch created before the merge keeps the old `push` trigger until it picks up the new `main`. Observed on `feature/explore-all-option-for`, which produced both a `push` and a `pull_request` run at 14:19, before the 14:27 merge. The twin disappears once the branch merges or rebases onto `main`.
