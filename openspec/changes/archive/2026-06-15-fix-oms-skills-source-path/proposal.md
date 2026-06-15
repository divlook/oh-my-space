## Why

`oms skills` currently points users and `--install` delegation at `npx skills add divlook/oh-my-space`. The external `skills` CLI discovers skills from standard repository locations, including agent-specific directories such as `.opencode/skills/`, `.codex/skills/`, and `.claude/skills/`. In this repository those directories contain OpenSpec development skills, so `npx skills add divlook/oh-my-space --list` exposes both the intended `oms` workspace skills and unrelated repository-development skills.

The intended public install surface is only `skills/oms-workspace`, `skills/oms-pointer`, and `skills/oms-branch`. The `skills` CLI supports a shorter GitHub source path, `divlook/oh-my-space/skills`, which limits discovery to the repository `skills/` directory and lists only the three intended `oms` skills.

## What Changes

- Change the `oms skills` guidance and delegation source from `divlook/oh-my-space` to `divlook/oh-my-space/skills`.
- Keep using the external `npx skills add` tool; do not implement a custom installer.
- Preserve pass-through behavior for `--install` extra arguments such as `-g`, `--skill`, `--list`, `--copy`, and agent selection flags.
- Update documentation command examples and tests so the advertised project, global, manual, and delegated commands all use the scoped source path.
- Record the discovery behavior: `npx skills add divlook/oh-my-space/skills --list` lists only the `oms` workspace skills, while `divlook/oh-my-space` may list additional repository-local skills.

## Capabilities

### Modified Capabilities
- `ai-workspace-skill`: Updates the external skill installation command contract to use the repository `skills/` source path.

## Impact

- `scripts/oms.ts`: `SKILLS_REPO`, help text, and delegated command output change to the scoped source.
- `README.md`: workspace skill installation examples change to the scoped source.
- `tests/cli.test.js`: command-output and delegation assertions change to expect `divlook/oh-my-space/skills`.
- `openspec/specs/ai-workspace-skill/spec.md`: main spec will be updated during the archive/sync step after implementation and verification.

## Non-Goals

- Implementing `oms`'s own skill installer.
- Supporting every agent path directly in `oms skills`.
- Moving or deleting this repository's OpenSpec development skills.
- Marking OpenSpec development skills as internal as part of this change; that remains an optional defense-in-depth follow-up.
