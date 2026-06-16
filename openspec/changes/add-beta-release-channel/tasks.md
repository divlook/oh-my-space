## 1. Release Channel Documentation

- [x] 1.1 Document the stable and beta npm channel model, including `latest` and `beta` dist-tags.
- [x] 1.2 Document user install commands for `oh-my-space@beta` and `oh-my-space@latest` across supported package managers where appropriate.
- [x] 1.3 Document maintainer beta publish, dist-tag verification, beta iteration, and stable promotion steps.
- [x] 1.4 Include rollback guidance for users returning to stable and maintainers moving the `beta` tag back to a known-good version.

## 2. Self-Update Behavior

- [x] 2.1 Locate the current `oms update` registry lookup, version comparison, and package-manager command selection flow.
- [x] 2.2 Detect when the installed CLI version is a semver prerelease.
- [x] 2.3 Update `oms update --check` output so prerelease installations report the installed prerelease version, the stable `latest` version, and beta/stable manual install guidance.
- [x] 2.4 Update mutating `oms update` output so prerelease installations make the selected target channel explicit before any global update command can run.
- [x] 2.5 Preserve existing stable-channel behavior for stable global installations, including `oh-my-space@latest` as the automatic update target.

## 3. Tests and Verification

- [x] 3.1 Add or update tests for prerelease version detection in the self-update flow.
- [x] 3.2 Add or update tests for `oms update --check` from a beta/prerelease installation.
- [x] 3.3 Add or update tests ensuring stable installations still update against `oh-my-space@latest`.
- [x] 3.4 Run `npm test`.
- [x] 3.5 Manually verify the documented npm dist-tag commands are coherent without publishing a real package unless intentionally performing a release.
