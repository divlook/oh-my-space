# Design

## Context

See proposal.md for motivation. The release workflow uses Changesets Action for both version PRs and `npm run release`, with `createGithubReleases: true`. The installed CLI is 3.0.3. The deployed Action revision `a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d` checks stdout for `New tag:` before calling tag push and Release creation; the two successful publish runs instead report `Created git tags.`.

The npm registry records source commits for both affected versions:

| Version | Published source commit | Publish run |
| --- | --- | --- |
| 2.0.0 | b2a86e8876ac76ffc8e4daed8146f82fe93613d1 | 38354050976 |
| 2.0.1 | 58af8b34c6d2801ea9900e8ff4275d3c2e70c1d6 | 38398773476 |

Both versions have entries in CHANGELOG.md. Existing script integration tests use Node's test runner and disposable Git repositories, with external package operations isolated at the process boundary. The release-channels spec still contains historical OMS 1.0 planning requirements; this change adds completion behavior without rewriting that unrelated history.

## Goals / Non-Goals

**Goals:**
- One owner for stable remote metadata, independent of CLI presentation text.
- The same finalization operation for automated publication and explicitly selected historical recovery.
- Commit identity verified before remote mutation, with recoverable partial completion.

**Non-Goals:**
- A new release service, a general multi-package release framework, or an automatic historical backfill on every main push.
- Changes to beta publishing, package validation, version calculation, npm authentication, or npm distribution policy.
- Editing existing Release prose or moving existing conflicting tags.

## Decisions

### 1. Finalize inside the stable publish command

Keep `changeset publish` as the publisher, then invoke a focused `scripts/finalize-stable-release.mjs` from the `release` npm script only when the publisher exits successfully. Set the Action's `createGithubReleases` to false so it does not compete with the explicit owner. Retain Changesets Action for version PRs and invocation of the stable publish command; its parsed `published` output is not a completion gate and is not used by this workflow.

This also permits completion when Changesets reports that a package is already published. A fresh publication failure never runs finalization. A finalization failure propagates through the publish command and fails the workflow rather than masking the incomplete release.

Alternatives: downgrading the CLI reverses the deliberate tooling upgrade; translating CLI output preserves the brittle parser contract; gating a later workflow step on the Action's `published` output repeats the defect. Upgrading the Action alone would require a verified compatible revision and would not supply historical recovery or explicit completion checks.

### 2. Derive and verify source identity from structured metadata

The finalizer defaults to the current package's stable version. A metadata-only invocation accepts `--version <version> --commit <full-sha>` for historical recovery; neither argument changes package files. Query the exact npm version as JSON, derive its `gitHead`, and require any explicitly supplied commit to match. Resolve that commit locally, require it to be reachable from the selected repository's main history, and read its package metadata and matching changelog section with Git rather than using current checkout notes. Reject missing evidence, prereleases, wrong package/version, or missing release notes before any remote write.

For an already published version on a later main commit, use the registry's verified historical commit, not current HEAD. Configure release checkout with full history so this verification works. Resolve the GitHub target explicitly as `divlook/oh-my-space`; do not infer a write target from an arbitrary current directory or use GitHub's default branch tip as a release target.

### 3. Use explicit GitHub metadata operations

Use authenticated GitHub CLI/API operations with the existing contents-write token. Inspect the remote tag, peeling annotated tags to their commit. Create a missing lightweight remote version ref at the verified commit through the API; do not push all local tags, force-update refs, or depend on checkout credential persistence. Existing matching annotated or lightweight tags are preserved.

Once the remote tag exists at the correct commit, create the published stable Release using that exact tag and extracted changelog entry, with tag verification enabled. Existing published, non-prerelease Releases for the verified tag are preserved without rewriting notes. Draft/prerelease Releases or conflicting tags cause a clear failure. Re-read remote state after creation; API read failures are not treated as absence. Do not automatically promote a historical backfill to GitHub's latest release; let GitHub's normal version ordering determine latest status.

This introduces an authenticated GitHub CLI prerequisite for local stable release completion; GitHub-hosted runners already provide it. Document that prerequisite rather than introducing another npm SDK dependency.

### 4. Recover the two versions explicitly, oldest first

After the finalizer has been exercised safely, invoke it without npm publication for 2.0.0 and then 2.0.1 using the exact commit table above. Check existing remote metadata immediately before each operation. Matching state is a no-op; conflicting state stops that recovery without destructive repair.

A successful tag creation followed by failed Release creation leaves a valid tag. Report the incomplete phase and the exact metadata-only command to resume. Do not roll back npm publication, delete a valid tag, or change dist-tags. No additional retry subsystem is introduced.

### 5. Verify behavior at real boundaries

Use disposable Git history and a local bare remote to prove commit selection and tag identity. Isolate registry and GitHub network calls behind process-level fixtures following existing integration conventions; assert externally visible metadata state, not command-string copies or workflow source text. Cover missing metadata, matching no-op, tag-only completion, conflicts, missing identity evidence, and partial failure with successful resumption.

Run a throwaway end-to-end smoke using the actual finalizer, a local Git remote, and controlled registry/GitHub boundary responses. Exercise successful finalization without `New tag:` output and repeat it to prove no duplicate release. Production completion is separately proven by reading actual remote tag commits and published Release state for both recovered versions. Do not publish a new npm package as a smoke test. Preserve the canonical `npm test` gate and check package contents using `npm pack --dry-run --ignore-scripts`.

## Risks / Trade-offs

- npm publication cannot be rolled back when GitHub fails → fail visibly and resume only metadata completion.
- Registry visibility can lag publication → fail with a recovery command rather than guess identity or add unrelated retry machinery.
- Historical Git objects may be absent in a shallow checkout → use full release history and report missing objects explicitly for local recovery.
- Concurrent external metadata writes can race with preflight reads → use create-only operations, verify resulting identity, and never force-update.
- A generic successful Action status previously concealed missing metadata → the explicit finalizer now controls publish-command success; retain a regression around this boundary.
- Local stable release now needs GitHub authentication → document GitHub CLI and contents-write access; beta requirements remain unchanged.

## Migration Plan

1. Add the finalizer, focused behavior coverage, stable npm-script integration, and single-owner workflow configuration while preserving the existing build/test gates.
2. Exercise disposable-fixture smoke, run the canonical gate, and update stable completion/recovery documentation and a Changeset summary without applying a version bump.
3. Use the new metadata-only operation to recover the two published versions at their verified source commits, then confirm remote tags, Release state and notes, and unchanged npm dist-tags.
4. Deploy the workflow update through the normal PR process. Do not rerun historical npm publication as a recovery mechanism.
5. If the new finalization path fails, preserve published artifacts and use its documented metadata-only recovery. Do not restore the known-broken automatic Action release ownership; revert an unshipped code change only without deleting recovered remote metadata.
