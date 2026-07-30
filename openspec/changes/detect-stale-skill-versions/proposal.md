## Why

The published `oms` workspace skills ship from the repository `skills/` directory over GitHub, while the CLI ships from npm. The two distribution channels are independent and neither carries a version, so an installed skill can silently drift from the CLI it was written against — leaving agents to follow stale guardrails with nothing surfacing the mismatch. Nothing today tells a user that the skills on their machine predate their `oms`, nor which command fixes it.

## What Changes

- Publish each skill with a `metadata.version` marker (string semver) and a `metadata.author` provenance field in its `SKILL.md` frontmatter, starting at `1.0.0`.
- Define a bump policy for that version: `major` for guardrail-kernel or scope-contract changes, `minor` for instruction or `description` changes, `patch` for typos and wording.
- Bake the published skill versions into the build output at build time so the CLI carries its own reference values with no hand-maintained duplicate.
- Add a skill-version check that locates installed copies, compares them against the baked reference, and reports drift with the exact remediation command. Report at `log.info` level; the check never changes an exit code.
- Run that check in `oms doctor`, and in `oms update` on the path where the running CLI is already current (where its baked reference is exact). After a successful self-upgrade, where the running process cannot know the new reference values, point the user to `oms doctor` instead of guessing.
- Guard the bump with a test that fails when a skill's content changes without its `metadata.version` moving.

No breaking changes: the marker is additive frontmatter, and the new reporting is informational only.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `ai-workspace-skill` — owns both the published skills and the `oms skills` command. This change extends the publication requirements with the version marker and bump policy, and adds requirements for the drift check surfaced by `oms doctor` and `oms update`.

## Impact

- `skills/oms-workspace/SKILL.md`, `skills/oms-pointer/SKILL.md`, `skills/oms-branch/SKILL.md` — add `metadata.author` and `metadata.version`.
- `scripts/build.mjs` — read the published skill versions and emit them alongside the existing build metadata in `dist/build-info.json`.
- `scripts/lib/env.ts` — read the baked skill versions, mirroring the existing `readBuildCommit` tolerance for a missing value.
- `scripts/lib/skills.ts` — locate installed skills and classify version drift.
- `scripts/lib/doctor.ts`, `scripts/lib/update.ts` — report drift.
- `tests/cli-tools.test.js` — frontmatter assertions, the content/version snapshot guard, and drift-reporting coverage; a new test override supplies the search roots.
- `README.md` — document what the skill version means and how to refresh installed skills.
- External dependency: the layout written by the Vercel Labs `skills` tool (lock files and agent skill directories) is read, never written.
