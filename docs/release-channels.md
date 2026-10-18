# Release channels

`oh-my-space` uses npm dist-tags to separate stable and beta CLI releases.

## Channels

- `latest`: stable channel. npm resolves `oh-my-space` to this channel by default.
- `beta`: opt-in prerelease channel. When available, this tag points to a SemVer prerelease such as `1.0.0-beta.sha-a1b2c3d`.

## User installs

Choose the command for your package manager.

For a stable install or rollback, use:

```bash
npm install -g oh-my-space@latest
pnpm add -g oh-my-space@latest
yarn global add oh-my-space@latest
bun add -g oh-my-space@latest
```

For a beta install, use:

```bash
npm install -g oh-my-space@beta
pnpm add -g oh-my-space@beta
yarn global add oh-my-space@beta
bun add -g oh-my-space@beta
```

## Maintainer beta flow

Use Node 24 from [`.nvmrc`](../.nvmrc) for stable and beta release preparation.

1. Add or confirm a pending Changeset whose computed `oh-my-space` release matches the intended next stable version.
2. Select a clean commit for the beta release.
3. Preview the beta package without publication:

```bash
npm test
npm run release:beta
```

4. To publish the beta package to the npm `beta` dist-tag, run:

```bash
npm run release:beta -- --publish
```

5. Check dist-tags manually if needed:

```bash
npm view oh-my-space dist-tags
```

6. Check that `beta` points to the intended prerelease.
7. Check that `latest` still points to the current stable release.

### Beta script reference

Maintainers publish beta releases manually from a selected clean commit.
Beta releases do not require a `beta` branch.
The script derives the intended stable base from the pending Changesets release plan.
It appends the current commit's short hash.
The resulting version is `<stable target>-beta.sha-<current commit short hash>`.
It restores package metadata after publication or a dry run.
The default dry run neither publishes a package nor moves npm dist-tags.

Run `npm test` on the selected commit before beta preparation so `prepack` can reuse its exact verification record.
Without that record, `prepack` runs the suite after the temporary prerelease version is set.
The current suite has stable-version assumptions in skill diagnostics and beta fingerprint fixtures; that unverified-checkout path fails.
The verified beta path reuses the stable-source test result, rebuilds the beta artifact, and checks CLI/package version parity without bypassing the package gate.

- The script requires exactly one pending `oh-my-space` release with a stable, forward `newVersion`.
- It rejects missing, ambiguous, prerelease, or non-forward release plans before it changes package metadata.
- It requires a clean working tree by default.
- It rejects `--publish --allow-dirty`. Published beta artifacts therefore match the printed source commit.
- It temporarily sets a version such as `1.0.0-beta.sha-a1b2c3d`.
- It runs npm's package flow, including the existing `prepack` test gate.
- It runs `npm publish --tag beta` only when you provide `--publish`.
- It restores `package.json` and `package-lock.json` when it finishes.
- It prints `npm view oh-my-space dist-tags` after a real publication.

### Historical beta reference

The historical `0.14.2-beta.sha-6d0b8be` package sorts below stable `0.14.2` because both use the same base version.
Do not unpublish that package.
Publication of the Changesets-derived `1.0.0-beta.sha-*` package advances the active `beta` tag.
This preserves npm history and gives skill compatibility ranges normal SemVer ordering.

## Beta iteration

For further beta fixes:

1. Keep the pending Changesets release target unchanged.
2. Select the new commit.
3. Run the beta release script again.

The script derives the same stable base.
The short hash creates a new prerelease version without a manual sequence number.

## Stable promotion

Promote a tested beta through publication of a stable SemVer version to `latest`.

Stable completion requires npm publication, a remote `v<version>` tag at the published npm `gitHead`, and a published, non-prerelease GitHub Release for that tag.
Use the GitHub CLI (`gh`) authenticated to `github.com` with contents-write access to `divlook/oh-my-space`.
For a local release, authenticate with `gh auth login` or supply a token through `GH_TOKEN` or `GITHUB_TOKEN`.
Use a full-history checkout with the published source commit and an up-to-date `origin/main` ref available locally.
The release workflow supplies full checkout history and its contents-write token; its test, package, and npm OIDC/provenance gates remain in place.

Do not retag the beta version as stable.
Confirm that pending Changesets describe the intended stable release before running `npm run version`.
This command applies the release intent to package metadata and the changelog, consumes the Changesets, and refreshes the lockfile; it does not publish.
With Changesets 3, no unreleased Changesets means exit code 1, not a successful no-op.
Package metadata remains unchanged, and the subsequent lockfile refresh does not run.
Add the intended release Changeset before retrying; do not suppress the failure.

```bash
npm run version
npm run release
npm view oh-my-space dist-tags
```

Check that `latest` points to the intended stable version.
Check that `latest` does not point to a prerelease such as `1.0.0-beta.sha-a1b2c3d`.

`npm run release` runs `changeset publish` first and finalizes GitHub metadata only if publication succeeds.
The finalizer also runs when Changesets successfully reports that the version is already published.
It does not parse Changesets publication messages.
The finalizer, not Changesets Action's built-in GitHub Release creation, owns stable remote metadata.

### Stable completion checks

Set `VERSION` to the exact stable version being checked:

```bash
VERSION=2.0.1
npm view oh-my-space@"$VERSION" name version gitHead --json
npm view oh-my-space dist-tags
git ls-remote https://github.com/divlook/oh-my-space.git \
  "refs/tags/v${VERSION}" "refs/tags/v${VERSION}^{}"
gh api --hostname github.com --method GET \
  "repos/divlook/oh-my-space/releases/tags/v${VERSION}" \
  --jq '{tag_name, draft, prerelease, html_url, body}'
```

Confirm all of the following:

- npm returns `name: "oh-my-space"`, the exact requested version, and a full source commit in `gitHead`.
- `latest` points to the intended stable version, not a prerelease.
- The remote `v<version>` tag resolves to that exact `gitHead`. For a lightweight tag, compare the tag line; for an annotated tag, compare the peeled `^{}` line.
- The GitHub Release has the exact tag, `draft: false`, and `prerelease: false`. Its body contains that version's changelog entry from the published source commit, not a later checkout's notes.

To inspect the historical notes, set `FULLSHA` to npm's `gitHead` and run `git show "${FULLSHA}:CHANGELOG.md"`.
Check the section headed by the exact version.
A successful npm publish or Changesets Action status alone does not establish stable release completion.

### Metadata-only recovery

If npm publication succeeded but GitHub completion failed, do not republish npm or move dist-tags.
The release command exits nonzero and identifies the incomplete phase and a metadata-only command:

```bash
node scripts/finalize-stable-release.mjs --version VERSION --commit FULLSHA
```

Replace `VERSION` with the published stable version and `FULLSHA` with its full, 40-character npm `gitHead`.
Both options are required for explicit historical recovery.
With neither option, the finalizer selects the current package version and derives its source commit from exact npm metadata; it does not assume that current `HEAD` is the published commit.

Before writing to `divlook/oh-my-space`, the finalizer verifies the exact npm package name, version, and `gitHead`.
It requires that commit to belong to `origin/main` history, using local `main` only if the remote-tracking ref is absent.
It reads `package.json` and the matching nonempty `CHANGELOG.md` version section from that commit.
Missing evidence, prerelease versions, mismatched identities, unavailable authentication, and API errors stop completion rather than selecting another commit.
Resolve the reported evidence or access failure before repeating the metadata-only command.

The finalizer inspects both remote tag and Release before any write, creates only missing metadata, and verifies the resulting remote state.
Matching lightweight or annotated tags are preserved, as are matching published stable Releases and their existing bodies.
It never moves or deletes a conflicting tag, overwrites release notes, or converts an existing draft/prerelease Release.
A conflict requires maintainer investigation, not a forced rerun.
Historical recovery does not force the recovered Release to become GitHub's latest.

If tag creation succeeds but Release creation fails, the valid tag remains.
Repeat the same metadata-only command after resolving the failure; completion resumes without duplicate Releases or rewriting matching metadata.
The operation does not change package files, publish npm packages, change dist-tags, or delete completed metadata.

The two historical recoveries use these published source commits, oldest first:

```bash
node scripts/finalize-stable-release.mjs --version 2.0.0 --commit b2a86e8876ac76ffc8e4daed8146f82fe93613d1
node scripts/finalize-stable-release.mjs --version 2.0.1 --commit 58af8b34c6d2801ea9900e8ff4275d3c2e70c1d6
```

Inspect remote state immediately before each recovery and repeat the stable completion checks afterward for each version.
For these historical versions, compare npm versions and dist-tags before and after recovery using `npm view oh-my-space versions --json` and `npm view oh-my-space dist-tags --json`; neither should change because of recovery.
Do not require `latest` to move back to a historical version.

## Rollback

To return to stable, use the stable install command for your package manager.
For example:

```bash
npm install -g oh-my-space@latest
```

If maintainers publish a bad beta, move the `beta` dist-tag to the last known-good beta version.
For example:

```bash
npm dist-tag add oh-my-space@0.12.0-beta.sha-a1b2c3d beta
npm view oh-my-space dist-tags
```

Maintainers should not unpublish npm versions after public consumption.
For stable release issues, publish a normal patch release instead.
