---
"oh-my-space": minor
---

Add a workspace-wide `mode` setting with `submodule` (backward-compatible default) and a new `worktree` mode. Worktree mode stores each repository as a bare common repository under `.oms/repos/<alias>.git` and checks out managed linked worktrees under `oms/<alias>/<name>`, so multiple branches of the same repository can be checked out concurrently without recording exact source SHAs in the parent project.

New commands and behavior:

- `oms worktree add|list|move|remove` with portable names, `alias/name` targets, local branch preservation, external-worktree visibility, and destructive-operation safeguards.
- `oms mode switch <submodule|worktree>` for explicit, preflighted, resumable transitions that ask whether to stop after the transition or also sync target topology, with optional root commits. Mode switch never pushes to a remote and preserves unpublished local state by copying verified object closures before any deletion.
- `sync`, `status`, `commit`, `branch`, `fetch`, `pull`, `push`, `unsync`, `doctor`, `init`, and target inference are now mode-aware while keeping submodule behavior intact. `oms.yaml` remotes are treated as authoritative, with declared-remote fetch, safe cached-ref fallback, and stationary checked-out worktree branches during sync.

BREAKING: `oms status --json` now emits mode-aware schema version 2 for every workspace mode, defined normatively by `oms.status.schema.json` and the exported TypeScript types; schema version 1 is removed. Status consumers must migrate to version 2.

BREAKING: the minimum supported Git version is raised from 2.40 to 2.48 so worktree metadata can use relative paths and a complete workspace can move without repair.

See `docs/migrations/worktree-mode-and-status-v2.md` for status v1-to-v2, the Git 2.48 requirement, and explicit submodule/worktree transition guidance including rollback limits.
