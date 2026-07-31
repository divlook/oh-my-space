# Optimize Local Tests and Publish Verification

## Baseline

- Synchronized source revision: `94f3e1290a32a1f271f6f897296ee36922d2cbd7`.
- Inventory: 295 unique observable test names: 292 direct declarations plus three generated workspace-discovery cases.
- Original ownership: `cli-branch-list.test.js` 19, `cli-branch.test.js` 28, `cli-commit.test.js` 74, `cli-scaffold.test.js` 36, `cli-sync.test.js` 75, and `cli-tools.test.js` 63.
- Local acceptance runtime: Apple M2, Darwin 25.5.0 arm64, Node.js 24.18.1, warm dependencies.
- The first normalized baseline attempt completed the 295-test inventory in 78.53 seconds but exposed one compatibility case that intentionally depended on a repository hook. The case now explicitly opts into hooks and that failed attempt is excluded from successful timing evidence.

### Representative cache-miss CI timings

Run [30549610461](https://github.com/divlook/oh-my-space/actions/runs/30549610461) provides the representative cache-miss entries used by this change.

| Matrix entry | Resolved Node | Test step |
| --- | --- | ---: |
| minimum-supported | 20.19.0 | 38 s |
| development | 24.18.0 | 55 s |

The current worktree is not a pushed GitHub revision, so no GitHub-hosted run can cover its exact fingerprint yet. Exact local cache-miss-equivalent canonical runs passed on Node 20.19.0 in 54.29 seconds and Node 24.18.1 in 54.91 seconds. The workflow resolves the same two runtimes and executes the same `npm test` Test step.

## Canonical Normalized Environment

Canonical tests remove inherited `NODE_OPTIONS`, `NODE_PATH`, Git/SSH askpass and command overrides; ignore system/global Git configuration and system attributes; force the `C` locale; disable commit and tag signing; disable external hooks; permit the required file protocol; and set deterministic author/committer identity. A compatibility test that exercises one of these settings must opt in within its owned fixture.

The verification key records exact Node and Git version strings, OS name and version, and CPU architecture after normalization. The final local record key prefix was `7db748230377` on Node 24.18.1.

## Exclusion Evidence

- `dist/` and `.test-dist/` are generated from included source and configuration and are always rebuilt.
- `node_modules/` is installed from included package and lock metadata and is never a source input.
- `.oms-verification.json` and `.ci-verified` are verification outputs, not inputs.
- `openspec/`, `docs/`, `.claude/`, and the named root project records cannot affect runtime or canonical tests.
- `skills/*/SKILL.md` remains included because canonical tests read and validate skill content.
- Every unknown tracked path and every non-ignored, non-excluded untracked path is included by default.

Unit and integration tests proved path/content/mode sensitivity, relevant untracked inclusion, fail-safe unknown paths, exact exclusions, malformed records, worktree isolation, environment-field separation, pre/post-run stability, and atomic-record failure behavior.

## Contract Migration Map

The synchronized mapping covers the complete 295-name inventory: each original name maps to the identically named retained black-box contract. The four largest inventories are single-sourced in contract modules and selected exactly once by deterministic entry shards:

| Contract module | Baseline names | Shards |
| --- | ---: | ---: |
| `cli-branch-list.contracts.js` | 19 | 2 |
| `cli-branch.contracts.js` | 28 | 3 |
| `cli-commit.contracts.js` | 74 | 3 |
| `cli-sync.contracts.js` | 75 | 3 |

`cli-scaffold.test.js` retains 36 names and `cli-tools.test.js` retains 63 names. This reconciles to 295 unique retained names with no consolidation, duplication, or deletion.

The new lower-layer contracts are additive:

| Replacement layer | Contract group |
| --- | --- |
| unit | raw Git inputs, branch/ref parsing, dirty and topology classification, record verdicts, manifest validation, update/install decisions, agent transforms, skill versions, prompt selection, help, and verification record matching |
| shallow integration | tracked/untracked fingerprint behavior, exclusions, beta normalization, record persistence/isolation, prepack fallback/reuse/build/artifact behavior, registry failure, and signal restoration |
| black-box | all synchronized 295 named CLI/Git contracts using immutable template fixtures and deterministic shards |

## Performance Measurements

Git-layer concurrency was measured against the same 295-contract inventory:

| Concurrency | Measurement |
| ---: | ---: |
| 2 | 91.02 s standalone black-box run |
| 4 | 57.68 s black-box phase; 64.23 s complete canonical run |
| 6 | 47.16 s standalone black-box run |

Concurrency six is the explicit winner. The final three comparable complete Node 24 runs were 55.78, 55.24, and 55.23 seconds: median 55.24 seconds, worst 55.78 seconds. A post-Changeset confirmation completed in 54.91 seconds. All are below the 60-second median and 75-second worst-run limits.

## Package and Workflow Evidence

- Matching `prepack` reused tests but always rebuilt `dist/oms.js`, smoke-executed the fresh CLI, and checked package/lock/artifact version parity.
- Missing, malformed, forced, mismatched, changed-during-run, test-failure, record-write-failure, and artifact-failure paths fell back or invalidated fail-safely.
- Direct `npm pack --dry-run` reused the final record and produced exactly six files.
- A real tarball retained `bin.oms = dist/oms.js`; its extracted CLI printed `0.14.2`.
- Direct `npm publish --dry-run` reached package inspection and then refused the already-published `0.14.2`; the corrected package manifest no longer loses its executable mapping.
- Beta integration covered dry-run-to-publish reuse, exact HEAD-derived version normalization, fresh beta artifacts, registry failure, metadata restoration, and SIGTERM restoration.
- A real PTY selected the combined AGENTS/CLAUDE target and installed both managed instruction files successfully.
- `changeset status` accepted the new patch Changeset and the repository's combined release plan.
- CI marker lookup remains pre-install with no prefix restore, exact runtime/image/architecture/content keys, auditable marker content, and a cache-hit job summary.
- Release still runs explicit `npm test`; subsequent Changesets publication can reuse that worktree-local record while `prepack` rebuilds and smoke-checks the artifact.
- `openspec validate optimize-local-tests-and-publish --type change --strict --no-interactive` passed.

## Remaining External Confirmation

A pushed revision must still receive cache-miss GitHub-hosted Node 20.19 and Node 24 Test steps at or below 60 seconds. The exact local matrix equivalents pass, and representative GitHub timings pass, but this worktree cannot produce its own GitHub Actions run before it is committed and pushed.
