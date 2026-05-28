---
"oh-my-space": minor
---

**Breaking**: replace the submodule data model with `git clone --bare` + worktrees.

Each registered alias now lives as `sources/<alias>/.bare/` (the bare clone) plus one or more `sources/<alias>/<branch>/` worktrees. `oms sync` initializes the bare clone, sets the missing `remote.origin.fetch` refspec, writes a `gitdir: ./.bare` placeholder, and creates the baseline worktree with `git worktree add --track -B <branch> <branch> origin/<branch>`. `.gitignore` is updated to exclude `sources/` on first sync.

- New: `oms worktree add|list|remove <alias> <branch>` for managing additional worktrees alongside the baseline. Slash-containing branches stay nested (`feature/foo` → `sources/<alias>/feature/foo/`).
- New: `oms doctor` now reports each alias's bare-clone state, `remote.origin.fetch`, `.git` placeholder, and `.gitignore` exclusion.
- Changed: `oms sync`/`unsync`/`fetch`/`pull`/`push` operate on the new layout. `fetch` runs against the bare clone; `pull`/`push` use the baseline worktree (configured with upstream).
- Removed: support for the legacy submodule layout. `oms sync` aborts with a migration hint when `.gitmodules` still registers a `sources/<alias>` entry; see the README "Migrating from 0.2.x" guide for the manual steps.
- `sources.yaml` schema is unchanged (backward compatible with 0.2.x); additional worktrees are intentionally not persisted in YAML and are treated as per-machine ephemeral state.
