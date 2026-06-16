## Context

`oh-my-space` is published as an npm CLI package. The current stable release flow uses Changesets with `npm run version` and `npm run release`, and the published package defaults to the npm `latest` dist-tag. Users install the stable CLI with package-manager commands such as `npm install -g oh-my-space`.

The repository already has a safe pre-publish gate through `prepack`, which runs the full test suite before packaging. The missing piece is a deliberate prerelease channel that lets maintainers publish and use beta builds without moving the default stable install target.

The current `cli-self-update` specification states that confirmed global updates install `oh-my-space@latest`. That is safe for stable users, but beta users need explicit channel semantics so a self-update does not appear ambiguous.

## Goals / Non-Goals

**Goals:**

- Provide a clear beta release path using npm prerelease versions and the `beta` dist-tag.
- Keep stable installs on the npm `latest` dist-tag.
- Give maintainers a repeatable flow for publishing, testing, iterating, and promoting releases.
- Document how users can install beta builds and return to stable builds.
- Define `oms update` behavior for beta/prerelease installations.

**Non-Goals:**

- Add a hosted staging environment; this is a CLI package, so npm channel separation is the deployment boundary.
- Replace Changesets with a different release tool.
- Automatically promote beta builds to stable without maintainer action.
- Support arbitrary named channels such as `alpha`, `nightly`, or `canary` in this change.
- Add telemetry or remote feature flags.

## Decisions

### Use npm dist-tags as release channels

Use npm's existing dist-tag model:

- `latest`: stable channel used by default installs.
- `beta`: prerelease channel used by explicit beta installs.

Alternatives considered:

- Separate package name such as `oh-my-space-beta`: rejected because it splits package identity, documentation, and install/update behavior.
- GitHub-only prereleases: rejected as the primary channel because the CLI is installed through package managers, and npm tags are the user-facing distribution mechanism.
- Branch-only testing: rejected because it does not validate the actual published package installation path.

### Use commit-derived semver prerelease versions for beta builds

Beta builds should use semver prerelease identifiers derived from the target stable version and source commit, such as `0.12.0-beta.sha-a1b2c3d`. Stable promotion should publish the corresponding stable version such as `0.12.0` to `latest`.

This keeps each beta npm version unique, makes the source commit visible in the package version, avoids maintaining a manual beta sequence, and keeps npm, package managers, and user expectations aligned.

### Treat beta promotion as a new stable publish, not retagging the same version

The stable release should be a stable semver version published to `latest`, even if its content matches the final beta build. Retagging `0.12.0-beta.sha-a1b2c3d` as `latest` would make default users install a prerelease-looking version, which weakens the stable channel contract.

### Make `oms update` stable-by-default

`oms update` should continue to target `oh-my-space@latest` unless a beta-aware behavior is explicitly requested or safely inferred. For a prerelease-installed CLI, the command should make the channel transition visible before mutating the installation.

The conservative behavior is:

- Stable installed version: check and update against `latest`.
- Beta installed version with `--check`: report both the installed prerelease and the stable `latest` state, and explain how to install the beta channel manually if needed.
- Beta installed version with mutation: avoid silently switching channels unless the selected command and output make the target channel clear.

A future enhancement can add explicit channel flags such as `oms update --channel beta`, but this change does not require that flag unless implementation finds it necessary for clarity.

### Automate the local beta publish mechanics, not the channel decision

The first version should avoid branch-based or CI-triggered beta publishing. Instead, provide a local maintainer script that prepares a temporary beta version, runs npm's package flow, publishes with `--tag beta` only when explicitly requested, verifies dist-tags, and restores local package metadata afterward.

## Risks / Trade-offs

- Beta users may accidentally remain on beta longer than intended -> Document both beta installation and stable rollback commands next to each other.
- Maintainers may publish a prerelease with the wrong dist-tag -> Include explicit verification steps such as checking `npm view oh-my-space dist-tags` after publish.
- `oms update` channel semantics may surprise beta users -> Make command output explicit about whether it targets `latest` or beta guidance.
- Manual release steps can drift over time -> Keep the process short and script the temporary version and publish mechanics.
- Promoting stable as a separate version can duplicate release work -> Accept the duplication to preserve a clean stable semver contract.

## Migration Plan

1. Add beta release documentation and maintainer steps.
2. Update `oms update` behavior and tests to handle prerelease-installed versions clearly.
3. Publish a beta version with the local beta release script and the `beta` dist-tag.
4. Install the beta package globally in a real environment and smoke test core commands.
5. If stable, publish the stable semver version to `latest`.
6. If unstable, publish the next beta prerelease or instruct users to return to `latest`.

Rollback strategy:

- For users: reinstall the stable channel with `npm install -g oh-my-space@latest` or the equivalent package-manager command.
- For npm tags: move the `beta` tag back to the last known-good beta version if a bad beta was published.
- For stable releases: follow normal patch release practices; npm versions cannot be unpublished safely after public consumption.

## Open Questions

- Should `oms update` eventually support an explicit `--channel beta` flag, or is documented manual beta installation enough for now?
- Should CI automation publish beta builds later, or should beta publishing remain an intentional local maintainer action?
