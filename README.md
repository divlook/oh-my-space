# oh-my-space

`oh-my-space` provides the `oms` CLI for managing external source repositories declared in `sources.yaml`. It syncs those entries into Git submodules under `sources/<alias>/` and runs safe fetch/pull/push operations inside selected source worktrees.

Package name: `oh-my-space`

Command name: `oms`

## Requirements

- [Node.js](https://nodejs.org) `>=20.19.0` for running `oms`; development uses the version in `.nvmrc` (`24`)
- git

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

List, sync, and unsync registered source repositories:

```bash
oms doctor              # check sources.yaml and git availability
oms sync --list         # list registered source repos
oms sync <alias>...     # add/init/update submodules by alias
oms sync --all          # add/init/update every registered source repo
oms sync                # interactive multi-select
oms unsync <alias>...   # remove submodule + worktree (sources.yaml entry kept)
oms unsync --all        # unsync every registered source repo
oms unsync --force ...  # discard uncommitted changes in the source worktree
```

## Managing source repositories

`sources.yaml` declares each source repo with `alias`, `url`, and optional `branch`. Checkouts live as Git submodules under `sources/<alias>/`.

| Command | Runs in | Does | Notes |
| --- | --- | --- | --- |
| `oms doctor` | project root or child path | Validates `sources.yaml` and checks `git --version`. | Fails when `sources.yaml` is missing or invalid. |
| `oms sync <alias>` / `--all` | workspace root | Adds missing submodules and initializes/updates registered ones. | Syncs `sources.yaml` to `sources/<alias>/`. |
| `oms unsync <alias>` / `--all` | workspace root | Deinits the submodule and removes `sources/<alias>/` (leaves the staged change to commit). | Keeps the entry in `sources.yaml`; pass `--force` to discard uncommitted changes in the worktree. |
| `oms fetch ...` | selected checked-out submodule worktree | `git fetch --all --prune` | Does not change the superproject gitlink. |
| `oms pull ...` | selected checked-out submodule worktree | `git pull --ff-only` | Requires a branch with upstream; detached HEAD/no-upstream states fail. |
| `oms push <alias>...` | explicitly selected checked-out submodule worktree | `git push` | No `--all`, force push, or automatic upstream setup. |

To add a repo, add it under `repos:` in `sources.yaml`, run `oms sync <alias>`, then commit `sources.yaml`, `.gitmodules`, and the gitlink change.

Standard Git submodule commands still work, for example:

```bash
git submodule update --init --recursive
```

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
- `branch` is optional and is passed to `git submodule add --branch` only when adding a new submodule.

## Release and versioning

`oh-my-space` uses SemVer:

- Patch: bug fixes and documentation changes.
- Minor: new commands/options or backward-compatible behavior additions.
- Major: removed/renamed CLI behavior, incompatible `sources.yaml` semantics, or a higher required runtime.

GitHub Releases are the user-facing release notes. This repository intentionally does not maintain a separate `CHANGELOG.md`.

Publishing is automated from `main` through Changesets. Feature branches and pull requests run tests on Node.js `20.19.0` and the `.nvmrc` development line (`24`), plus `npm pack --dry-run`; publish only happens through the release workflow after the release PR is merged. The release job builds and publishes on Node.js `20.19.0` so the package is verified against the minimum supported runtime.

## License

[MIT](./LICENSE)
