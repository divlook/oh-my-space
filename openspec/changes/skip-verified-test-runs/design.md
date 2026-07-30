## Context

The CI workflow triggers on both `pull_request` and `push` with `branches-ignore: [main]`. Every push to a branch with an open pull request therefore produces two workflow runs for the identical head commit, seconds apart, each running a two-entry Node matrix.

Pull request #62 illustrates the cost. Its four pushes produced sixteen job executions but only two distinct test-relevant contents, measured with the fingerprint this change introduces:

| Push | Subject | Fingerprint | Necessary |
| --- | --- | --- | --- |
| `49cc103` | perf(test): optimize black-box test execution | `dceb6f8bcbb8` | yes |
| `0b86395` | docs(openspec): record test execution results | `dceb6f8bcbb8` | no |
| `dcf0956` | chore(openspec): archive optimize test execution | `dceb6f8bcbb8` | no |
| `edf587d` | Merge branch 'main' into optimize-test-execution | `cbda4f05022c` | yes |

The two documentation-only commits reproduce the first push's fingerprint exactly. The merge commit does not: merging `main` brought in changes outside the exclusion list, so it introduced genuinely new content and had to be verified. Four of the sixteen executions were necessary.

Separately, `edf587d` and the `main` merge commit `a6f4e01` share the tree `60fd388f`, so the `Release` run re-verified content the pull request had already verified. That case is deliberately left alone; see the decision below.

The previous `optimize-test-execution` change already reduced the suite itself to near its floor: the CI `Test` step runs 36-39 s, `npm run build` takes 0.95 s, dependency install is 1-3 s from cache, and `npm pack --dry-run` is under 1 s. The remaining waste is not inside the suite but in running it against content that was already verified.

Two platform behaviours constrain the design, and both were verified against this repository's own history rather than assumed:

- **Cache scopes are isolated per trigger.** The same cache key appears three times in this repository's cache list — `refs/heads/feature/medaka` at 13:00:07, `refs/pull/59/merge` at 13:00:16, `refs/heads/main` at 13:07:47 — and the same pattern repeats for `feature/dottyback` and `refs/pull/60/merge`. `actions/cache` skips saving on an exact-key hit, so all three runs missed. Documentation agrees: runs cannot restore caches created for sibling branches, and a pull request cache is created for the merge ref.
- **Successive runs on one pull request do share a scope.** On `feat/add-worktree-mode`, a run on 2026-07-18 logged `npm cache is not found` and saved a key; runs on 2026-07-20 and 2026-07-22 logged `Cache restored from key` for that exact key. All three were `event=pull_request`, `run_attempt=1`, with distinct head commits, so these were separate `synchronize` pushes and not re-runs. No `Release` run occurred between 2026-07-17 and 2026-07-23, so the default-branch scope could not have supplied the key. The documented wording, "can only be restored by re-runs of the pull request", is looser than the observed behaviour.

Together these fix the shape of the solution: memoization through the Actions cache works within one pull request and cannot work across the `push`/`pull_request` split. Consolidating to one trigger is a precondition, not an alternative.

## Goals / Non-Goals

**Goals:**

- Never execute the canonical full suite twice for the same test-relevant content within a pull request.
- Make an incorrect skip structurally difficult: unknown paths must invalidate the memo, and an unavailable memo must cause execution rather than a skip.
- Keep status checks reporting on every event so required checks can be introduced later.
- Make every skip traceable to the run that verified the content.
- Add no third-party actions, no additional token permissions, and no repository writes.

**Non-Goals:**

- Reducing billed runner minutes. This repository is public, so standard-runner minutes are free; the motivation is redundant work and feedback latency, not cost.
- Deduplicating release validation. `release.yml` is untouched.
- Making the suite itself faster. `cli-sync.test.js` dominates the critical path at roughly 36 s in CI and is not addressed here.
- Widening the test matrix. Untested `win32` branches and the missing Node 22 entry are real gaps but belong to a separate change.

## Decisions

### Consolidate to the `pull_request` trigger

The `push` trigger is removed. This is the precondition that makes a cache-backed memo function at all, and it also removes the duplicate run outright rather than detecting it after the fact.

The two runs are not strictly redundant today: `actions/checkout` on `pull_request` checks out the merge commit, so the pull request run verifies the merge result while the push run verifies the branch tree. The merge result is the more meaningful target — it is what lands on the default branch under either a merge commit or a squash merge — so dropping the branch-tree run loses little.

Alternatives considered:

- **Keep both triggers and memoize across them.** Requires a store readable from both scopes: a marker artifact (retention limits, listing noise), a git ref or note (needs `contents: write`, which forks cannot use), or an Actions API lookup serialized by a non-cancelling concurrency group (adds roughly 60 s of wall clock and can only key by head SHA, not by fingerprint). All three trade away stability for a duplicate that consolidation removes for free.
- **Guard the push job with "an open pull request exists for this ref".** Needs an API lookup and still double-runs the first push, since the pull request does not exist yet when that push arrives.
- **Third-party `skip-duplicate-actions`.** Works, but adds a supply-chain dependency for behaviour expressible in first-party steps.

### Store the memo as an Actions cache marker, looked up on an exact key

`actions/cache/restore` with no `restore-keys`, so only an exact key satisfies the lookup. Omitting `restore-keys` is essential — prefix matching would let a marker for different content satisfy the lookup.

The marker is fully restored rather than probed with `lookup-only: true`. The auditable-skip requirement needs the marker's contents to name the vouching run, and `lookup-only` reports only whether the key exists without downloading the file. The marker is a few hundred bytes, so restoring it costs nothing worth optimising.

The store's reliability does not affect correctness: a miss always executes the suite. Cache eviction after seven days of no access, or the 10 GB repository limit, degrade the hit rate and nothing else.

### Derive the fingerprint from the whole tree minus a declared exclusion list

```sh
EXCLUDE='^(openspec|docs|\.claude)/|^(README|CHANGELOG|AGENTS|CLAUDE)\.md$'

git ls-tree -r HEAD | awk -F'\t' -v re="$EXCLUDE" '$2 !~ re' | sha256sum | cut -c1-64
```

`git ls-tree -r` emits `<mode> <type> <object>` and the path separated by a tab, sorted by path, so the digest is deterministic and covers file content, mode, and layout.

The exclusion list is a denylist by deliberate choice. An allowlist of "paths that affect tests" fails silently the moment a new source directory appears; a denylist makes any unrecognised path contribute to the fingerprint, so the failure mode is an unnecessary run. This matters concretely here: `tests/cli-tools.test.js` reads and asserts on `skills/*/SKILL.md` content, so a naive `**.md` exclusion would have skipped genuinely relevant changes. Only directories that contain no code and individually named root documents are excluded — no markdown glob.

A useful consequence is that `package.json`, `.nvmrc`, `tests/**`, and `.github/workflows/ci.yml` are tracked files outside the exclusion list, so they enter the fingerprint automatically. No separate `hashFiles()` entry is needed for the harness or the workflow definition.

Alternative considered: `git rev-parse HEAD^{tree}`, a plain whole-tree hash. Simpler and equally sound, but documentation-only commits would bust it, which forfeits the case that motivates the change.

### Compose the key from the fingerprint plus every out-of-tree variable

```
ci-verified-v1-${ImageOS}-${RUNNER_ARCH}-node${RESOLVED_NODE}-${FINGERPRINT}
```

- `ImageOS` (for example `ubuntu24`) rather than `runner.os`, because `ubuntu-latest` drifts across images and `Linux` would not capture that.
- `RESOLVED_NODE` is the output of `node -v` after `setup-node`, not the literal `24` in `.nvmrc`. Keying on the file's content would reuse a Node 24.11 result on Node 24.12.
- A `v1` scheme prefix so the memo can be invalidated deliberately without contriving a tree change.

Because the key is per-job, a pass on the minimum-supported entry never vouches for the development entry.

### Skip steps, never the job or the workflow

Each matrix job always runs; only the install, test, and package-inspection steps carry the miss condition. Two reasons: a job that reports nothing is indistinguishable from a job that was never scheduled, and GitHub leaves required checks pending when a workflow is skipped by a path filter, which blocks merging. This is also why `paths-ignore` is excluded entirely — path filters on `pull_request` evaluate a three-dot diff over the whole pull request, so they cannot skip a documentation commit inside a code pull request, and they carry the pending-check hazard for no benefit the fingerprint does not already provide.

### Make the marker carry the vouching run's identity

The marker file records the run URL, the verified commit, the resolved Node version, and the fingerprint. A skipping job prints these to its job summary. Without this a skipped run is an unexplained green check.

### Leave `release.yml` alone

Pull request markers are provably unreadable from `main`, so consuming them would require the cross-scope store rejected above. More importantly the default-branch run is not a duplicate: a pull request run verifies a predicted merge, while the release run verifies the content that actually landed. Base movement between the last pull request run and the merge can make those differ, and this run is the last gate before `changeset publish` invokes `prepack`.

## Risks / Trade-offs

- **A test-relevant path is added to the exclusion list** → the strongest failure mode in the design, since it produces silent false skips. Mitigations: the list contains only code-free directories and individually named root documents, with no markdown glob; `skills/*/SKILL.md` stays in the fingerprint because the suite asserts on it; any change to the list warrants explicit review.
- **Branches without a pull request lose CI** → the one workflow change this asks of the developer: open a draft pull request when the branch is created. Local `npm test` remains available.
- **The duplicate run is currently a free flakiness canary** → running identical content twice would surface nondeterminism, and commit `c62f9dd` did fail identically in both twins. That signal disappears. If it turns out to be wanted, a scheduled repeat run is a more deliberate replacement than an accidental duplicate.
- **Branch-tree verification is lost** → accepted, since the merge result is what reaches the default branch under both merge strategies.
- **The memo hides a genuine failure after a flaky pass** → a marker is written only after the suite passes, so a flaky pass can vouch for content whose next run would fail. This risk exists identically today whenever a green run is trusted.
- **Cache eviction reduces hit rate on long-lived pull requests** → after seven days of no access a marker disappears and the suite runs. Correct, only slower.
- **`ImageOS` or the resolved Node version changes mid-pull-request** → the key changes and the suite runs. Correct by construction.

## Migration Plan

1. Land the workflow change in a single pull request. That pull request validates the mechanism on itself: the first push misses, and a follow-up documentation-only push must hit and skip.
2. Confirm on that pull request that the skipped job reports success, names the vouching run in its summary, and that a subsequent code change misses again.
3. Adopt the draft-pull-request habit for new branches.

Rollback is a revert of the workflow file; no state outside the Actions cache is involved, and stale markers become unreachable once the key scheme or workflow content changes.

## Open Questions

- Should the exclusion list also cover `.github/ISSUE_TEMPLATE/` and other non-workflow GitHub metadata? Excluded for now, since including them only costs unnecessary runs.
- Should a scheduled repeat run replace the flakiness signal the duplicate provided? Deferred until there is evidence of flakiness.
- Is the branch-tree run worth preserving as a conditional second pass when the merge tree and head tree differ? It can be added later inside the same job by comparing the two tree hashes, with no store involved, but it is not part of this change.
