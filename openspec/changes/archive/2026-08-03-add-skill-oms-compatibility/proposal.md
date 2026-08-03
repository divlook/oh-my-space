## Why

OMS skills are installed from the repository `main` branch while the CLI is released independently through npm, so a stable CLI can receive skill instructions for commands that exist only in a beta build. Skill freshness and CLI compatibility must be represented separately before OMS moves to the 1.0 release line.

## What Changes

- Add a machine-readable OMS semver requirement and the standard human-readable Agent Skills `compatibility` field to every published OMS skill.
- Validate and bake both each skill's own version and its OMS compatibility range into CLI build metadata.
- Separate skill-freshness diagnostics from runtime-compatibility diagnostics, including channel-aware remediation when a skill requires the upcoming 1.0 prerelease or stable release.
- Define `1.0.0` as the target stable line for the current post-`0.14.2` feature set, derive that target from pending Changesets when publishing beta, and produce `1.0.0-beta.sha-<commit>` rather than a prerelease of the already-published `0.14.2`.
- Update skill authoring, release-channel, command, and testing documentation so future instruction changes raise the minimum OMS range only when they depend on newer CLI behavior.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `ai-workspace-skill`: Add explicit OMS runtime compatibility metadata, build-time validation, compatibility-aware diagnostics, and channel-specific remediation for installed skills.
- `release-channels`: Require beta versions to use the intended next stable version, with the current development line targeting OMS `1.0.0`.

## Impact

- Published files: `skills/*/SKILL.md` gain compatibility declarations.
- Build/runtime metadata: `scripts/build.mjs`, `dist/build-info.json`, and skill metadata readers carry version ranges in addition to skill versions.
- CLI diagnostics: `oms doctor` and the up-to-date path of `oms update` distinguish stale skills from skills incompatible with the running CLI.
- Release tooling: `scripts/publish-beta.mjs` derives the target stable version from the pending Changesets release plan and refuses missing or ambiguous plans; the next beta is published on the `1.0.0-beta.sha-*` line.
- Tests and documentation: skill frontmatter validation, drift classification, beta version generation, command output, and AI coding tool guidance are updated.
- Release operation: publishing or promoting OMS `1.0.0` remains a maintainer action after this change; this proposal prepares and records that target rather than publishing it automatically.
