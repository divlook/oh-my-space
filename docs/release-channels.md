# Release channels

`oh-my-space` uses npm dist-tags to separate stable and beta CLI releases.

## Channels

- `latest`: stable channel. This is the default npm resolution target for `oh-my-space`.
- `beta`: opt-in prerelease channel. This tag points to a semver prerelease such as `1.0.0-beta.sha-a1b2c3d` when a beta is available.

## User installs

Stable install or rollback:

```bash
npm install -g oh-my-space@latest
pnpm add -g oh-my-space@latest
yarn global add oh-my-space@latest
bun add -g oh-my-space@latest
```

Beta install:

```bash
npm install -g oh-my-space@beta
pnpm add -g oh-my-space@beta
yarn global add oh-my-space@beta
bun add -g oh-my-space@beta
```

## Maintainer beta flow

Beta releases are manually published from a selected clean commit. They do not require a `beta` branch. The script derives the intended stable base from the pending Changesets release plan, appends the current commit short hash, and restores package metadata after publishing or dry-running.

First add or confirm a pending Changeset whose computed `oh-my-space` release is the intended next stable version. Preview the beta package without publishing:

```bash
npm run release:beta
```

Publish the beta package to the npm `beta` dist-tag:

```bash
npm run release:beta -- --publish
```

The script:

- Requires exactly one pending `oh-my-space` release with a stable, forward `newVersion`.
- Rejects missing, ambiguous, prerelease, or non-forward release plans before changing package metadata.
- Requires a clean working tree by default.
- Rejects `--publish --allow-dirty` so published beta artifacts always match the printed source commit.
- Temporarily sets a version such as `1.0.0-beta.sha-a1b2c3d`.
- Runs npm's package flow, including the existing `prepack` test gate.
- Publishes with `npm publish --tag beta` only when `--publish` is provided.
- Restores `package.json` and `package-lock.json` after it finishes.
- Prints `npm view oh-my-space dist-tags` after a real publish.

Verify dist-tags manually if needed:

```bash
npm view oh-my-space dist-tags
```

Confirm that `beta` points to the intended prerelease and that `latest` still points to the current stable release.

The historical `0.14.2-beta.sha-6d0b8be` package sorts below stable `0.14.2` because both use the same base version. Do not unpublish it. Publishing the Changesets-derived `1.0.0-beta.sha-*` package moves the active `beta` tag forward while preserving npm history and gives skill compatibility ranges normal SemVer ordering.

## Beta iteration

For follow-up beta fixes, keep the pending Changesets release target unchanged, choose the new commit, and run the beta release script again. The script derives the same stable base, while the short hash creates a new prerelease version without a manual sequence number.

## Stable promotion

Promote a tested beta by publishing a stable semver version to `latest`, not by retagging the beta version as stable.

```bash
npm run version
npm run release
npm view oh-my-space dist-tags
```

Confirm that `latest` points to the intended stable version and not to a prerelease such as `1.0.0-beta.sha-a1b2c3d`.

## Rollback

Users can return to stable with the stable install command for their package manager, for example:

```bash
npm install -g oh-my-space@latest
```

If a bad beta was published, move the `beta` dist-tag back to the last known-good beta version:

```bash
npm dist-tag add oh-my-space@0.12.0-beta.sha-a1b2c3d beta
npm view oh-my-space dist-tags
```

Published npm versions should not be unpublished after public consumption. For stable release issues, publish a normal patch release instead.
