## Why

Users need a safe, first-party way to keep the `oms` CLI current after installing it globally. Today they must remember the correct package manager command themselves, even though `oms` can inspect its own runtime location and recommend the right update path.

## What Changes

- Add an `oms update` command that checks the latest published `oh-my-space` version from the npm registry.
- Detect the current installation context from the running CLI path and package metadata.
- Automatically update only confident global installations after showing the detected context and command.
- Provide safe guidance instead of mutating the environment for project-local, one-shot runner, development, or unknown installations.
- Add a non-mutating `--check` mode and a `--yes` mode for confirmed global updates.

## Capabilities

### New Capabilities
- `cli-self-update`: Covers checking for newer CLI releases, detecting the current installation context, and safely updating or guiding users.

### Modified Capabilities

## Impact

- CLI command surface in `scripts/oms.ts`.
- Runtime package metadata and installation path inspection.
- Network access to the npm registry for latest-version lookup.
- Package-manager command execution for confident global installs.
- CLI tests and README command documentation.
