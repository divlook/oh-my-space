---
"oh-my-space": minor
---

Return the data model to git submodules, with `oms` as a thin wrapper over the submodule foot-guns.

Each alias is now a git submodule at `oms/<alias>/` instead of a bare clone + worktrees, so the pinned commit, branch, and `.gitmodules` entry are tracked in your project's history (reproducible pin, `git status` visibility, pointer travels with commits). `oms/` is no longer gitignored.

- `oms sync` runs `git submodule add` for new aliases, `git submodule update --init` for registered-but-uninitialized ones, and attaches the baseline branch at the pinned commit (never a detached HEAD).
- `oms checkout <alias> <branch>` switches to a branch, creating it locally when it exists nowhere yet — no remote precondition. The remote branch is created lazily on the first `oms push`.
- `oms push` uses `git push -u origin <branch>` and stages the moved pointer; `--commit` also records it. `oms pull` advances the current branch and stages the pointer.
- `oms status` reports branch, pointer state, dirtiness, and ahead/behind per submodule.
- The `oms worktree` command group is removed; branch switching happens in the single submodule working tree via `oms checkout`.
- The workspace must be a git repository. A leftover bare clone (`oms/<alias>/.bare`) blocks `sync` with a migration hint.

See `docs/migrations/0.5.x-to-0.6.0.md` for the migration steps.
