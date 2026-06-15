# oh-my-space

## 0.11.3

### Patch Changes

- [#40](https://github.com/divlook/oh-my-space/pull/40) [`652b01f`](https://github.com/divlook/oh-my-space/commit/652b01fc7b8dd1bedbdd1cb02afd46127fbd6529) Thanks [@divlook](https://github.com/divlook)! - build: bundle the CLI into a single dependency-free `dist/oms.js`. The build now type-checks with `tsc --noEmit` and bundles via esbuild, inlining the former runtime dependencies (`commander`, `@clack/prompts`, `semver`, `yaml`) so the published package declares no runtime dependencies. Internally, the monolithic `scripts/oms.ts` was split into cohesive `scripts/lib/*` modules. No user-facing CLI behavior, command surface, or output changes.

## 0.11.2

### Patch Changes

- [#38](https://github.com/divlook/oh-my-space/pull/38) [`3c1319a`](https://github.com/divlook/oh-my-space/commit/3c1319a3133e99f8b12aa713d726c8c23933f9d5) Thanks [@divlook](https://github.com/divlook)! - `oms skills` now points to the scoped `divlook/oh-my-space/skills` source so `npx skills add` discovers only the three `oms` workspace skills (`oms-workspace`, `oms-pointer`, `oms-branch`), excluding repository-development skills from agent directories such as `.opencode/skills/`, `.codex/skills/`, and `.claude/skills/`. Affects the printed project/global commands, `--install` delegation, and manual-fallback output.

## 0.11.1

### Patch Changes

- [#36](https://github.com/divlook/oh-my-space/pull/36) [`c45f166`](https://github.com/divlook/oh-my-space/commit/c45f1668b4950e0c162e535b14c3b8685543fdd7) Thanks [@divlook](https://github.com/divlook)! - `oms init` now prints optional AI-setup hints after scaffolding `oms.yaml`, pointing to `oms agent install` and `oms skills`. Additive output only — no new command, flag, or behavior change.

## 0.11.0

### Minor Changes

- [#34](https://github.com/divlook/oh-my-space/pull/34) [`4682615`](https://github.com/divlook/oh-my-space/commit/4682615af323f1354641c3f7504676563fc6ab99) Thanks [@divlook](https://github.com/divlook)! - Add installable `oms` workspace skills and an `oms skills` command.

  Three agent skills are now published under `skills/<name>/SKILL.md` and installable with the external `skills` tool (`npx skills add divlook/oh-my-space`, `-g` for a global install, `--skill <name>` for one, `--list` to list them):

  - `oms-workspace` — establishes workspace state and root-versus-submodule scope before scope-ambiguous Git work, and separates repo add/remove topology (`oms sync`/`oms unsync`) from recording a moved pointer (`oms record`).
  - `oms-pointer` — records the root pointer with `oms record` after `oms commit` or `oms pull` moves a submodule's commit.
  - `oms-branch` — chooses `oms switch` (new local branch) versus `oms checkout` (track a remote branch) and avoids detached HEAD.

  Each skill carries the scope-guardrail kernel verbatim (single-sourced with the `oms/` marker block, drift-tested) and defers exact `oms status --json` field semantics to `oms status --help`. The new `oms skills` command prints the project-scope and `-g` global install commands, and `oms skills --install` resolves to the workspace root and delegates to `npx skills add`, forwarding extra arguments straight through.

## 0.10.0

### Minor Changes

- [#31](https://github.com/divlook/oh-my-space/pull/31) [`9b42fc6`](https://github.com/divlook/oh-my-space/commit/9b42fc65eae5d7f312d05d6d106635a8b7f2e9f6) Thanks [@divlook](https://github.com/divlook)! - Add AI-assisted submodule workflow commands and make root pointer commits explicit.

  - `oms status --json` emits one schema-versioned, machine-readable JSON object on stdout describing the workspace root, the current alias, root submodule pointers (`moved`/`staged`/`split`/`conflict`), and each submodule's branch, head, tracking branch, dirtiness, numeric ahead/behind, and pin. Both the JSON and the human-readable table now expose `missing` and `conflict` pins.
  - `oms commit [alias] -m <message>` commits source changes inside the selected submodule only, never the root gitlink. It is staged-first (commits existing staged changes as-is, otherwise stages all with `git add -A`), supports repeated `-m`, and can infer the alias from the current `oms/<alias>/` directory.
  - `oms record [alias]` commits an existing root gitlink pointer update for one alias as `chore(oms): update <alias> submodule to <sha>`, path-limited to `oms/<alias>` with strict index safety.
  - `oms agent install|uninstall [--target agents|claude|both]` manages a marker-delimited (`<!-- OMS START -->` / `<!-- OMS END -->`) instruction block in the root-repository files `oms/AGENTS.md` and/or `oms/CLAUDE.md`, preserving content outside the markers and never staging the files.

  BREAKING:

  - `oms push --commit` is removed and `oms push --record` is unsupported. Both fail before pushing with guidance to run `oms push <alias>` and then `oms record <alias>`.
  - `oms pull` and `oms push` no longer stage or commit the root gitlink. They synchronize only the submodule branch and print an `oms record <alias>` hint when the pointer moves. `oms pull` now rejects a dirty submodule; `oms push` warns but proceeds.
  - `oms sync` and `oms unsync` no longer leave root topology changes staged. `.gitmodules` and `oms/<alias>` stay in the working tree, unstaged; create the topology commit through the interactive prompt or with `--commit` (`chore(oms): add submodule` / `chore(oms): remove submodule`).

## 0.9.1

### Patch Changes

- [#28](https://github.com/divlook/oh-my-space/pull/28) [`4ebe217`](https://github.com/divlook/oh-my-space/commit/4ebe21768252e913315f66d5b4ebf5f3cedcd9f9) Thanks [@divlook](https://github.com/divlook)! - Add the `oms update` command for safe CLI self-update checks and global updates.

## 0.9.0

### Minor Changes

- [#26](https://github.com/divlook/oh-my-space/pull/26) [`e988022`](https://github.com/divlook/oh-my-space/commit/e988022000579f79cb76d08e04255f72eb4c2a65) Thanks [@divlook](https://github.com/divlook)! - Allow `oms.yaml` aliases to include underscores and `@`, while keeping aliases lowercase and still requiring the first character to be an ASCII lowercase letter or digit.

## 0.8.0

### Minor Changes

- [#24](https://github.com/divlook/oh-my-space/pull/24) [`dd1bf67`](https://github.com/divlook/oh-my-space/commit/dd1bf67fbf3816b5f9fe76eff49994120ed4fa1b) Thanks [@divlook](https://github.com/divlook)! - Split `oms checkout` into two focused commands. `oms switch [alias] [branch]` manages LOCAL branches — switch to an existing one or create a new one (`--from <ref>` sets the start point), with no remote precondition and no upstream tracking. `oms checkout [alias] [branch]` fetches origin and checks out a REMOTE branch (`origin/*`) as a local tracking branch (or switches to an existing local counterpart). Both commands accept an omitted alias and/or branch and prompt interactively (synced submodules, and local or `origin/*` branches), failing fast on a non-interactive shell. BREAKING: `oms checkout <alias> <branch>` no longer creates a brand-new local branch — use `oms switch` for that. See docs/migrations/0.7.x-to-0.8.0.md.

## 0.7.1

### Patch Changes

- [#22](https://github.com/divlook/oh-my-space/pull/22) [`7f720bb`](https://github.com/divlook/oh-my-space/commit/7f720bb386a7af100835eb9e71bd8d9d7ea62f30) Thanks [@divlook](https://github.com/divlook)! - Fix `oms unsync` leaving orphaned state behind when several aliases are unsynced at once. The `.gitmodules` section and `.git/config` entry are now stripped explicitly instead of relying on `git rm`'s implicit edit, `.gitmodules` is removed once no submodule remains registered (rather than only when the file is byte-empty), and the empty `.git/modules/oms/` container is cleaned up. Failed aliases (for example a submodule with uncommitted or untracked changes) are now named at the end of the run so a buried failure isn't mistaken for success.

## 0.7.0

### Minor Changes

- [#21](https://github.com/divlook/oh-my-space/pull/21) [`d609555`](https://github.com/divlook/oh-my-space/commit/d609555bc025e54e0301ac98bc1a7d8ae11970c3) Thanks [@divlook](https://github.com/divlook)! - Support multiple git remotes per source. The `oms.yaml` `url` field is replaced by a `remotes` mapping (which must include an `origin` entry), and `oms sync` configures every declared remote on the submodule. `fetch`, `pull`, and `push` accept a repeatable `--remote <name>` flag, and prompt to choose a remote interactively when one is not given (defaulting to `origin` on a non-interactive shell). `push` sets the upstream only for `origin` so `oms status` keeps measuring against it. This is a breaking manifest change; see docs/migrations/0.6.x-to-0.7.0.md.

### Patch Changes

- [#19](https://github.com/divlook/oh-my-space/pull/19) [`bd7330b`](https://github.com/divlook/oh-my-space/commit/bd7330b82a062c9f2e4ee55a4ae2475c94ab5844) Thanks [@divlook](https://github.com/divlook)! - Print migration-doc hints as clickable GitHub permalinks pinned to the build commit, instead of repo-relative paths, so they are clickable in the terminal and never break when files move on the default branch.

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
