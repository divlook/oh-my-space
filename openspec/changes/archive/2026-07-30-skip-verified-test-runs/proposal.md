## Why

Every push to a pull request branch currently runs the full black-box suite four times: the `push` and `pull_request` triggers both fire for the identical head commit, and each runs a two-entry Node matrix. Measured against pull request #62, sixteen job executions covered only two distinct test-relevant contents: the two documentation-only commits reproduced the exact content the first push had already verified, while the `main` merge commit legitimately introduced new content. Four of the sixteen executions were necessary. CI should not re-verify content it has already verified.

## What Changes

- **BREAKING (workflow contract)**: Remove the `push` trigger from the CI workflow. CI runs on `pull_request` only. Branches without an open pull request no longer receive CI, so a pull request (draft is sufficient) becomes the entry point for automated verification.
- Add a cancelling concurrency group to the CI workflow so superseded runs stop instead of completing.
- Introduce a content fingerprint computed from the checked-out tree, excluding an explicitly declared set of paths that cannot affect test outcomes.
- Memoize successful verification: each matrix job looks up a marker keyed by fingerprint plus every outcome-affecting variable that lives outside the tree, and skips the build, install, test, and package-inspection steps on an exact hit.
- Record the vouching run's identity in the marker and report it in the job summary, so a skipped run states which earlier run verified the content.
- Keep the job itself running on a hit so the status check still reports, rather than skipping the job or filtering by path.
- Leave `release.yml` unchanged. The `main` run verifies the content that actually landed on `main`, which is a different guarantee from the merge result a pull request run predicts.

## Capabilities

**New Capabilities**: none.

**Modified Capabilities**:
- `test-execution` — adds requirements for single-trigger CI validation, fail-safe content fingerprinting, verification memoization with a complete cache key, and auditable skips. Extends the existing non-duplicative CI theme from package inspection to the test run itself.

## Impact

- `.github/workflows/ci.yml`: trigger set, concurrency, fingerprint and marker steps, step-level conditions.
- `.github/workflows/release.yml`: unchanged.
- Test suite, build, and `package.json` scripts: unchanged. `npm test` remains the canonical full-suite command; the memoization decides only whether to invoke it.
- Developer workflow: opening a pull request early becomes required for CI feedback.
- Branch protection: no required status checks exist today. The design keeps checks reporting so required checks can be added later without blocking merges.
- Actions cache usage: markers are a few hundred bytes. Removing the `push` trigger also halves duplicated npm cache storage, currently about 119 MB across scopes.

### Verified assumptions

Both mechanisms this change depends on were verified against this repository's own run history and the GitHub documentation before proposing:

- Successive `pull_request` runs on the same pull request restore caches saved by an earlier run on that pull request. Observed on `feat/add-worktree-mode`: a run on 2026-07-18 reported a cache miss and saved a key, and runs on 2026-07-20 and 2026-07-22 — separate `synchronize` pushes with distinct head commits and `run_attempt` 1 — restored that exact key. No `Release` run occurred between 2026-07-17 and 2026-07-23, so the default-branch scope could not have supplied it.
- Caches are isolated between the `push` and `pull_request` scopes, and pull request caches are unreadable from `main`. Observed as the same cache key stored three times: `refs/heads/feature/medaka`, then `refs/pull/59/merge` nine seconds later, then `refs/heads/main` after the merge. `actions/cache` skips saving on an exact hit, so all three runs missed. This is why the single-trigger change is a precondition for memoization rather than an alternative to it, and why `release.yml` cannot consume pull request markers.
- Path filters on `pull_request` evaluate a three-dot diff across the whole pull request, not the latest push, so `paths-ignore` cannot skip a documentation commit inside a pull request that also changes code. A workflow skipped by a path filter also leaves required checks pending and blocks merging. Path filtering is therefore excluded from this change.
