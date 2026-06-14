## Why

`oms` exposes AI-facing primitives (`oms status --json`, `oms commit`, `oms record` from the `ai-submodule-workflow` change), but agents still need procedural guidance to use them with the correct repository scope. The `oms agent install` marker block lives under `oms/` and is blind to sessions started at the workspace root, so an installable skill — discovered by the agent's skill mechanism regardless of working directory — is the layer that reaches the agent when the marker cannot.

## What Changes

- Publish three skills under `skills/<name>/SKILL.md` at the repository root, installable with `npx skills add divlook/oh-my-space` (the `add` subcommand is required; `--skill <name>` installs one, `--list` lists them):
  - `oms-workspace` (umbrella): the scope guardrail itself, not a router — run `oms status --json` before Git work in an `oms.yaml` workspace, decide root versus `oms/<alias>` scope without guessing, and never create a root pointer commit unless explicitly asked. Its distinct job is delivering this guardrail to root-level sessions the marker block cannot reach.
  - `oms-commit-record` (workflow): the cross-command commit then record loop, so submodule source commits are not left without a recorded root pointer and the root pointer is not committed by mistake.
  - `oms-branch` (workflow): choosing `oms switch` (new local branch) versus `oms checkout` (track an existing remote branch) and avoiding detached HEAD.
- Each skill restates the one-line scope guardrail so it is self-sufficient; skill firing is best-effort, so a skill must not assume the umbrella loaded first.
- Skills defer exact `oms status --json` field semantics to the README `status --json` section as the authoritative source and declare a `schemaVersion: 1` expectation as a fail-safe; command flag and syntax detail defer to `oms <command> --help`. Skill bodies stay portable, with no agent-specific slash-command syntax.
- Add the `oms skills` command (moved here from `ai-submodule-workflow`): it prints `npx skills add divlook/oh-my-space`; `oms skills --install` delegates to that command with inherited stdio and returns its exit code; on delegation failure it prints the manual command; an internal `OMS_NPX_BIN` override allows testing without real `npx`.
- Document the skills and the `oms skills` command in the README.

## Capabilities

### New Capabilities
- `ai-workspace-skill`: Covers the installable `oms` workspace skills (umbrella scope guardrail plus cross-command workflow skills) and the `oms skills` command that guides users to install them.

### Modified Capabilities
- None. The `oms skills` requirement was removed from the `ai-submodule-workflow` change before it produced a main spec, so there is no archived spec to modify.

## Impact

- New `skills/oms-workspace/`, `skills/oms-commit-record/`, `skills/oms-branch/` skill sources.
- New `oms skills` command in `scripts/oms.ts` with CLI tests in `tests/cli.test.js`.
- README skill installation and command-reference updates.
- Depends on `ai-submodule-workflow` landing `oms status --json`, `oms commit`, and `oms record` first; the skills are meaningless without those primitives.
- The `oms skills` command and its scenarios were already removed from `ai-submodule-workflow` and belong to this change.
