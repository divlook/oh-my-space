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

1. Add or confirm a pending Changeset whose computed `oh-my-space` release matches the intended next stable version.
2. Select a clean commit for the beta release.
3. Preview the beta package without publication:

```bash
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
It restores package metadata after publication or a dry run.

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
Do not retag the beta version as stable.

```bash
npm run version
npm run release
npm view oh-my-space dist-tags
```

Check that `latest` points to the intended stable version.
Check that `latest` does not point to a prerelease such as `1.0.0-beta.sha-a1b2c3d`.

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
