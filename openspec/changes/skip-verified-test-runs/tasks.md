## 1. Trigger consolidation

- [x] 1.1 Remove the `push` trigger from `.github/workflows/ci.yml` so CI runs on `pull_request` only
- [x] 1.2 Add a cancelling concurrency group keyed on the workflow and ref
- [x] 1.3 Confirm `permissions` stays at `contents: read` and that no new token scope is introduced

## 2. Fingerprint

- [x] 2.1 Add a step that computes the content fingerprint from `git ls-tree -r HEAD`, excluding the declared path list, and emits it as a step output
- [x] 2.2 Declare the exclusion list as `openspec/`, `docs/`, `.claude/`, and the individually named root documents `README.md`, `CHANGELOG.md`, `AGENTS.md`, `CLAUDE.md`, with an inline comment stating that no markdown glob may be used because the suite asserts on `skills/*/SKILL.md`
- [x] 2.3 Verify locally that the fingerprint is stable across repeated invocations on one commit and differs between two commits whose non-excluded content differs
- [x] 2.4 Verify locally that the fingerprint reproduces the measured values for pull request #62: `49cc103`, `0b86395`, and `dcf0956` all yield `dceb6f8bcbb8`, `edf587d` yields `cbda4f05022c`, and `49cc103^` yields `4179ec6c85c6`

## 3. Verification key

- [x] 3.1 Capture the resolved runtime version from `node -v` after `setup-node` as a step output
- [x] 3.2 Assemble the key as `ci-verified-v1-${ImageOS}-${RUNNER_ARCH}-node<resolved>-<fingerprint>`
- [x] 3.3 Confirm the assembled key differs between the two matrix entries for the same commit

## 4. Memoization

- [x] 4.1 Add an `actions/cache/restore` step with no `restore-keys`, restoring the marker rather than using `lookup-only`, and exposing the hit result as a step output
- [x] 4.2 Gate `Install dependencies`, `Test`, and `Pack dry run` on a lookup miss
- [x] 4.3 On a miss that passes, write the marker file containing the run URL, verified commit, resolved runtime version, and fingerprint, then save it with `actions/cache/save` under the exact key
- [x] 4.4 Confirm no marker is written when the suite fails

## 5. Reporting

- [x] 5.1 On a hit, write the vouching run URL, verified commit, resolved runtime version, and fingerprint to `$GITHUB_STEP_SUMMARY`
- [x] 5.2 Confirm the job runs and reports a successful conclusion on a hit rather than a skipped or pending status
- [x] 5.3 Confirm no `paths` or `paths-ignore` filter is present in the workflow

## 6. End-to-end verification on the implementing pull request

- [ ] 6.1 Push the workflow change and confirm both matrix entries report a lookup miss and execute the suite
- [ ] 6.2 Push a follow-up commit that changes only an excluded path and confirm both entries hit, skip verification, and report the vouching run from step 6.1
- [ ] 6.3 Push a follow-up commit that changes a non-excluded path and confirm both entries miss and execute the suite again
- [ ] 6.4 Confirm exactly one workflow run is created per push, with no branch-push twin
- [ ] 6.5 Confirm the `Release` workflow still executes the canonical full suite after the merge lands on `main`

## 7. Record results

- [ ] 7.1 Record the observed miss, hit, and miss sequence with run URLs and per-job durations in `verification.md`
- [ ] 7.2 Compare the implementing pull request's total job executions against the four-push baseline of pull request #62
- [ ] 7.3 Add a changeset only if user-facing behaviour changes; note explicitly if none is required because the change is limited to CI configuration
