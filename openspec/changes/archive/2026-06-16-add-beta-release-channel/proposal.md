## Why

Users need a safe way to try upcoming `oh-my-space` CLI changes before they become the default stable release. A beta release channel lets maintainers publish prerelease builds, install and use them in real workflows, and promote only stable behavior to the normal `latest` channel.

## What Changes

- Introduce a documented beta release channel for prerelease CLI builds using npm prerelease versions and the `beta` dist-tag.
- Define the release flow from local validation, to beta publication, to beta usage, to stable promotion.
- Document how users install the beta channel and return to the stable channel.
- Clarify how `oms update` should behave when the installed CLI is on a prerelease/beta version.
- No breaking changes.

## Capabilities

### New Capabilities
- `release-channels`: Defines stable and beta npm release channels, including publication, installation, promotion, and rollback guidance.

### Modified Capabilities
- `cli-self-update`: Clarify update behavior for prerelease/beta installations so `oms update` does not accidentally surprise users with unclear channel semantics.

## Impact

- Affected documentation: `README.md`, release documentation or maintainer notes if present.
- Affected package metadata/release process: Changesets prerelease flow and npm dist-tags.
- Affected CLI behavior: `oms update` channel detection and user guidance for beta versus stable installs.
- Affected tests: self-update tests and any release-channel documentation checks added during implementation.
