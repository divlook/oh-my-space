# oh-my-space

`oh-my-space` provides the `oms` CLI for managing external source repositories declared in `sources.yaml`. Each registered repo lives as a bare clone under `sources/<alias>/.bare/` and the baseline branch (and any additional ones you ask for) checks out as a Git worktree at `sources/<alias>/<branch>/`.

Package name: `oh-my-space`

Command name: `oms`

## Requirements

- [Node.js](https://nodejs.org) `>=20.19.0` for running `oms`; development uses the version in `.nvmrc` (`24`)
- git `>=2.40` (worktree `--track -B` flow)

For local development:

```bash
nvm use
npm ci
npm test
```

## Install

Install globally with your package manager of choice:

```bash
npm install -g oh-my-space
pnpm add -g oh-my-space
yarn global add oh-my-space
bun install -g oh-my-space
```

## Quick start

Create a `sources.yaml` in your project root:

```yaml
repos:
  - alias: api
    url: git@github.com:example/api.git
    branch: main
  - alias: web
    url: git@github.com:example/web.git
```

Sync and explore:

```bash
oms doctor                         # validate sources.yaml + bare/worktree state
oms sync --list                    # list registered source repos
oms sync <alias>...                # bare-clone + create the baseline worktree
oms sync --all                     # sync every registered source repo
oms sync                           # interactive multi-select
oms worktree add <alias> <branch>  # add another worktree alongside the baseline
oms worktree list [alias]          # show every worktree
oms worktree remove <alias> <br>   # remove a single worktree
oms unsync <alias>...              # remove ALL worktrees + the bare clone
```

`oms sync` adds `sources/` to your workspace `.gitignore` on first run; the bare clone and worktrees stay out of your project history.

## Layout

For an alias `api` with the baseline branch `main` and an extra `feature/foo` worktree:

```
sources/
└── api/
    ├── .bare/             # git clone --bare result
    ├── .git               # 'gitdir: ./.bare' placeholder
    ├── main/              # worktree for main (upstream: origin/main)
    └── feature/
        └── foo/           # worktree for feature/foo
```

Slash-containing branch names are kept nested as directories.

## Managing source repositories

`sources.yaml` declares each source repo with `alias`, `url`, and optional `branch` (the baseline). Additional worktrees are created on demand with `oms worktree add` and are *not* persisted in `sources.yaml` — they're treated as per-machine working space.

| Command | Runs in | Does | Notes |
| --- | --- | --- | --- |
| `oms doctor` | project root or child path | Checks `sources.yaml`, git availability, `.gitignore`, and each alias's bare clone + `remote.origin.fetch`. | Returns exit 2 if any warning is raised. |
| `oms sync <alias>` / `--all` | workspace root | Bare-clones missing repos, fetches origin, creates the baseline worktree. | Adds `sources/` to `.gitignore` if absent. |
| `oms unsync <alias>` / `--all` | workspace root | Removes every worktree, the bare clone, and the `.git` placeholder for the alias. | Keeps the `sources.yaml` entry. Use `--force` to discard uncommitted changes. |
| `oms fetch ...` | workspace root | `git fetch origin --prune` on each bare clone. | Worktrees are not touched. |
| `oms pull ...` | workspace root | `git pull --ff-only` on the baseline worktree of each selected alias. | Requires the worktree to be on its branch with upstream set (the default after `oms sync`). |
| `oms push <alias>...` | workspace root | `git push` on the baseline worktree of each explicitly listed alias. | No `--all`, no force, no automatic upstream setup. |
| `oms worktree add <alias> <branch>` | workspace root | `git worktree add --track -B <branch> <branch> origin/<branch>` inside the alias. | Slash branches become nested directories. |
| `oms worktree list [alias]` | anywhere under root | Lists every worktree for the alias (or all aliases). | |
| `oms worktree remove <alias> <branch>` | workspace root | `git worktree remove <branch>` plus parent-directory cleanup for slash branches. | `--force` discards uncommitted changes. |

## `sources.yaml` format

```yaml
repos:
  - alias: service-a
    url: git@github.com:example/service-a.git
    branch: main
  - alias: docs
    url: https://github.com/example/docs.git
```

Rules:

- `repos` must be a non-empty array.
- `alias` must be unique and match `/^[a-z0-9][a-z0-9-]*$/`.
- `url` is required.
- `branch` is optional; when omitted the bare clone's default branch is used as the baseline worktree.

## Migrating from 0.2.x

0.2.x stored each alias as a Git submodule. 0.3.0 replaces that with a bare clone + worktrees. The data model is breaking — `oms sync` refuses to run while `.gitmodules` still registers a `sources/<alias>` path. Convert your workspace manually:

```bash
# 1. For each alias in sources.yaml, deinit and remove the submodule.
git submodule deinit -f sources/<alias>
git rm -f sources/<alias>
rm -rf .git/modules/<alias>

# 2. Drop the now-empty .gitmodules if nothing else uses it.
[ -s .gitmodules ] || rm -f .gitmodules

# 3. Add sources/ to .gitignore (oms sync will also do this).
grep -qxF 'sources/' .gitignore 2>/dev/null || echo 'sources/' >> .gitignore

# 4. Re-sync with the new model.
oms sync --all

# 5. Commit the result.
git add . && git commit -m "chore: migrate to oh-my-space 0.3.0 (bare + worktree)"
```

## License

[MIT](./LICENSE)
