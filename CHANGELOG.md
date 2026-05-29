# oh-my-space

## 0.6.0

### Minor Changes

- [#17](https://github.com/divlook/oh-my-space/pull/17) [`a283ca3`](https://github.com/divlook/oh-my-space/commit/a283ca3343bbabd84d0fa83de6777d05b763ebe4) Thanks [@divlook](https://github.com/divlook)! - Return the data model to git submodules, with `oms` as a thin wrapper over the submodule foot-guns.

  Each alias is now a git submodule at `oms/<alias>/` instead of a bare clone + worktrees, so the pinned commit, branch, and `.gitmodules` entry are tracked in your project's history (reproducible pin, `git status` visibility, pointer travels with commits). `oms/` is no longer gitignored.

  - `oms sync` runs `git submodule add` for new aliases, `git submodule update --init` for registered-but-uninitialized ones, and attaches the baseline branch at the pinned commit (never a detached HEAD).
  - `oms checkout <alias> <branch>` switches to a branch, creating it locally when it exists nowhere yet — no remote precondition. The remote branch is created lazily on the first `oms push`.
  - `oms push` uses `git push -u origin <branch>` and stages the moved pointer; `--commit` also records it. `oms pull` advances the current branch and stages the pointer.
  - `oms status` reports branch, pointer state, dirtiness, and ahead/behind per submodule.
  - The `oms worktree` command group is removed; branch switching happens in the single submodule working tree via `oms checkout`.
  - The workspace must be a git repository. A leftover bare clone (`oms/<alias>/.bare`) blocks `sync` with a migration hint.

  See `docs/migrations/0.5.x-to-0.6.0.md` for the migration steps.

## 0.5.0

### Minor Changes

- [#14](https://github.com/divlook/oh-my-space/pull/14) [`1c72894`](https://github.com/divlook/oh-my-space/commit/1c72894bd9a837cd03b1b593903fbbb239cebe12) Thanks [@divlook](https://github.com/divlook)! - Add the `oms init` command to scaffold a starter `oms.yaml` in the current directory. The generated file ships with a placeholder repo entry and a `# yaml-language-server: $schema=…` comment so YAML LSPs provide autocompletion and validation out of the box. `init` also registers `oms/` in `.gitignore` (marked with a `# managed by oms` comment, shared with `oms sync`), refuses to clobber an existing `oms.yaml`, and accepts `--force` to overwrite. The README's `oms.yaml` examples now include the schema comment as well.

## 0.4.0

### Minor Changes

- [#12](https://github.com/divlook/oh-my-space/pull/12) [`3c5acfb`](https://github.com/divlook/oh-my-space/commit/3c5acfb2d30169d5a6aff7910891c1be928e67de) Thanks [@divlook](https://github.com/divlook)! - **Breaking**: rename the manifest from `sources.yaml` to `oms.yaml` and the data directory from `sources/` to `oms/`. CLI commands (`oms sync`, `oms worktree …`) are unchanged but disk layout and the `.gitignore` entry move, so each workspace needs a one-time manual migration. When the old names are detected the CLI aborts and points at the new [`docs/migrations/0.3.x-to-0.4.0.md`](https://github.com/divlook/oh-my-space/blob/main/docs/migrations/0.3.x-to-0.4.0.md) guide. The schema file is renamed to `oms.schema.json`, the README's inline migration sections are moved into `docs/migrations/`, and `package.json` keywords/description are refreshed.

## 0.3.1

### Patch Changes

- [#9](https://github.com/divlook/oh-my-space/pull/9) [`ca314be`](https://github.com/divlook/oh-my-space/commit/ca314beb8c0df0c04800573fc55a87e141f59803) Thanks [@divlook](https://github.com/divlook)! - `oms doctor` now warns when the installed git is older than 2.40. The new model uses `git worktree add --track -B <branch> <branch> origin/<branch>` and older git versions can produce cryptic failures from `oms sync`/`worktree add` instead of a clear diagnostic. Detection is best-effort: if `git --version` output can't be parsed, doctor warns and continues.

## 0.3.0

### Minor Changes

- [#6](https://github.com/divlook/oh-my-space/pull/6) [`6ebc051`](https://github.com/divlook/oh-my-space/commit/6ebc051e94009bcb6f3dbd3f2dbdf3b05740fc0b) Thanks [@divlook](https://github.com/divlook)! - **Breaking**: replace the submodule data model with `git clone --bare` + worktrees.

  Each registered alias now lives as `sources/<alias>/.bare/` (the bare clone) plus one or more `sources/<alias>/<branch>/` worktrees. `oms sync` initializes the bare clone, sets the missing `remote.origin.fetch` refspec, writes a `gitdir: ./.bare` placeholder, and creates the baseline worktree with `git worktree add --track -B <branch> <branch> origin/<branch>`. `.gitignore` is updated to exclude `sources/` on first sync.

  - New: `oms worktree add|list|remove <alias> <branch>` for managing additional worktrees alongside the baseline. Slash-containing branches stay nested (`feature/foo` → `sources/<alias>/feature/foo/`).
  - New: `oms doctor` now reports each alias's bare-clone state, `remote.origin.fetch`, `.git` placeholder, and `.gitignore` exclusion.
  - Changed: `oms sync`/`unsync`/`fetch`/`pull`/`push` operate on the new layout. `fetch` runs against the bare clone; `pull`/`push` use the baseline worktree (configured with upstream).
  - Removed: support for the legacy submodule layout. `oms sync` aborts with a migration hint when `.gitmodules` still registers a `sources/<alias>` entry; see the README "Migrating from 0.2.x" guide for the manual steps.
  - `sources.yaml` schema is unchanged (backward compatible with 0.2.x); additional worktrees are intentionally not persisted in YAML and are treated as per-machine ephemeral state.

## 0.2.0

### Minor Changes

- [#1](https://github.com/divlook/oh-my-space/pull/1) [`bc91b17`](https://github.com/divlook/oh-my-space/commit/bc91b1778c1419d379d296a23844dbba689670d9) Thanks [@divlook](https://github.com/divlook)! - Add the global `oms` CLI package, Node.js build output, source repository management commands, and release automation.
