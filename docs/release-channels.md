# Release channels

`oh-my-space` uses npm dist-tags to separate stable and beta CLI releases.

## Channels

- `latest`: stable channel. This is the default npm resolution target for `oh-my-space`.
- `beta`: opt-in prerelease channel. This tag points to a semver prerelease such as `0.12.0-beta.sha-a1b2c3d` when a beta is available.

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

Beta releases are manually published from a selected clean commit. They do not require a `beta` branch. The beta package version is created temporarily from the chosen base stable version and the current commit short hash, then discarded locally after publish or dry-run.

Release builders must use Node 20.19 or newer and Git 2.48 or newer. Before publishing, record `node --version` and `git --version`, then require `npm run build`, `npm test`, and strict OpenSpec validation for the release change to exit 0. Git 2.48 is a release requirement because older Git versions cannot guarantee portable relative worktree metadata.

Preview the beta package without publishing:

```bash
npm run release:beta -- --base-version 0.12.0
```

Publish the beta package to the npm `beta` dist-tag:

```bash
npm run release:beta -- --base-version 0.12.0 --publish
```

The script:

- Requires a clean working tree by default.
- Rejects `--publish --allow-dirty` so published beta artifacts always match the printed source commit.
- Temporarily sets a version such as `0.12.0-beta.sha-a1b2c3d`.
- Runs npm's package flow, including the existing `prepack` test gate.
- Publishes with `npm publish --tag beta` only when `--publish` is provided.
- Restores `package.json` and `package-lock.json` after it finishes.
- Prints `npm view oh-my-space dist-tags` after a real publish.

Verify dist-tags manually if needed:

```bash
npm view oh-my-space dist-tags
```

Confirm that `beta` points to the intended prerelease and that `latest` still points to the current stable release.

## Beta iteration

For follow-up beta fixes, choose the new commit and run the beta release script again. The short hash creates a new prerelease version, so there is no manual beta sequence number to maintain.

## Stable promotion

Promote a tested beta by publishing a stable semver version to `latest`, not by retagging the beta version as stable.

```bash
npm run version
npm run release
npm view oh-my-space dist-tags
```

Confirm that `latest` points to the intended stable version and does not point to a prerelease such as `0.12.0-beta.1`.

## Rollback

Users can return to stable with the stable install command for their package manager, for example:

```bash
npm install -g oh-my-space@latest
```

Do not downgrade to a release that predates worktree mode while `.oms/repos/` or `.oms-mode-switch.json` exists. Complete or recover the transition, switch to submodule mode, and verify `oms doctor` first. Older releases do not understand status schema v2, worktree ownership, or transition journals and must refuse this state rather than attempting repair.

If a bad beta was published, move the `beta` dist-tag back to the last known-good beta version:

```bash
npm dist-tag add oh-my-space@0.12.0-beta.sha-a1b2c3d beta
npm view oh-my-space dist-tags
```

Published npm versions should not be unpublished after public consumption. For stable release issues, publish a normal patch release instead.
