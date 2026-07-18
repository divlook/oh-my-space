## Why

OMS currently requires every managed repository to be a Git submodule, which couples workspace identity, source checkout state, and parent-repository pointers. Developers who need multiple branches of the same repository checked out concurrently need a worktree-centered mode that remains safe and automation-friendly without pretending to provide submodule-style SHA reproducibility.

## What Changes

- Add a workspace-wide `mode` setting with `submodule` as the backward-compatible default and `worktree` as the new alternative.
- Add worktree-mode storage using bare common repositories under `.oms/repos/<alias>.git` and managed linked worktrees under `oms/<alias>/<name>`.
- Add `oms worktree add|list|move|remove` with portable names, `alias/name` targets, local branch preservation, external-worktree visibility, and destructive-operation safeguards.
- Make sync, status, commit, branch, fetch, pull, push, unsync, doctor, and target inference mode-aware while keeping submodule behavior intact.
- Add `oms mode switch <submodule|worktree>` for explicit, preflighted mode transitions that ask whether to stop after transition or also sync target topology, then complete the selected path with optional root commits and resumable recovery.
- Inventory committed, staged, and checked-out source OIDs plus every protected local ref and recoverable object during mode transitions; when unpublished submodule state needs protection, offer preservation in the new common repository or cancellation with manual-publication guidance before removal, and copy a selected unpublished worktree OID into verified staged submodule storage before reverse-transition deletion. Mode switch never pushes to a remote.
- Treat `oms.yaml` remotes as authoritative, support declared-remote fetch and safe cached-ref fallback, and keep checked-out worktree branches stationary during sync.
- Raise the minimum supported Git version to 2.48 and use relative worktree metadata so a complete workspace can move without repair.
- **BREAKING**: Replace `oms status --json` schema version 1 with a mode-aware schema version 2 for every workspace mode, defined normatively by `oms.status.schema.json` and matching exported TypeScript types.
- **BREAKING**: Raise the minimum supported Git version from 2.40 to 2.48.
- Document that worktree mode follows branches and does not record exact source SHAs in the parent project.

## Capabilities

### New Capabilities
- `worktree-workspace`: Defines worktree-mode configuration, repository and checkout lifecycle, command targeting, remote behavior, safety rules, mode switching, portability, and diagnostics.

### Modified Capabilities
- `workspace-context`: Separates workspace identity from enclosing Git topology and resolves managed worktree targets.
- `ai-submodule-workflow`: Replaces status JSON v1 with a mode-aware v2 contract and makes existing repository commands target worktrees where applicable.
- `init-onboarding`: Adds explicit mode scaffolding and permits nested or non-Git initialization for worktree mode.
- `readme-onboarding`: Positions OMS as a multi-repo workspace CLI supporting both submodule and worktree modes and documents both normal flows.
- `ai-workspace-skill`: Makes agent guardrails and workflow skills mode-aware, including worktree targets and the absence of root pointer recording in worktree mode.

## Impact

- Manifest parsing, JSON Schema, workspace discovery, Git-version checks, repository lifecycle, status modeling, prompts, root transactions, command help, and diagnostics will change.
- New worktree and mode command groups will be added; most existing commands will accept or resolve `alias/name` targets in worktree mode.
- Status consumers and published AI skills must migrate to schema version 2.
- README, package metadata, migration documentation, command help, and release notes must explain the two modes and the Git 2.48 requirement.
- Integration tests will need cross-mode coverage for remote failures, cached refs, path portability, destructive preflights, partial state, nested Git roots, external and locked worktrees, pointer-state preservation, and mode transitions with and without target sync or root commits.
