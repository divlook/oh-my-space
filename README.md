# oh-my-space

[![npm version](https://img.shields.io/npm/v/oh-my-space.svg)](https://www.npmjs.com/package/oh-my-space)

`oh-my-space` is a small CLI for managing multi-repo workspaces with Git submodules.

Declare external repositories in `oms.yaml` and sync them into `oms/<alias>/`. Your parent project records each repo's exact commit while you work with normal branch, pull, and push flows.

## When to use it

- You work across several repositories from one project workspace and want them checked out side by side.
- You want each source repo pinned to an exact commit so your workspace stays reproducible.
- You want to stay on a real branch during everyday submodule work instead of landing in a detached HEAD.
- You want pointer changes to show up in `git status` so you can review them before committing.

## Requirements

- [Node.js](https://nodejs.org) `>=20.19.0` to run `oms`.
- git `>=2.40` for `git switch` and the submodule commands `oms` relies on.
- Run `oms` from a Git repository. For a new workspace, run `git init` first, since sources are tracked as submodules of it.

## Install

Install `oh-my-space` to use the `oms` command. Install it globally with your package manager of choice:

```bash
npm install -g oh-my-space
pnpm add -g oh-my-space
yarn global add oh-my-space
bun install -g oh-my-space
```

## Quick start

Run `oms init` to scaffold a starter `oms.yaml` in your project root, then edit it down to the repositories you need. A minimal one-repo config looks like this:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/divlook/oh-my-space/main/oms.schema.json
repos:
  - alias: api
    remotes:
      origin: git@github.com:example/api.git
    branch: main # optional; defaults to the remote's default branch
```

Sync the declared repositories and check their state:

```bash
oms sync --all   # add/initialize every declared repo on its baseline branch
oms status       # branch / pointer / dirty / ahead-behind per submodule
```

## Layout

A workspace with two declared repositories, `api` and `web`, looks like this:

```
oms.yaml               # declares each source repo (alias, remotes, branch)
.gitmodules            # registers each oms/<alias> -> origin url, branch
oms/
├── api/               # git submodule (a normal working tree, on a branch)
└── web/               # git submodule (a normal working tree, on a branch)
```

`oms.yaml` is your declaration, `.gitmodules` and each `oms/<alias>` gitlink are tracked in your project history, and every directory under `oms/` is a normal checked-out repository you can branch, edit, and commit in.

## Typical branch flow

Start a branch, do the work inside the submodule, push it, then record the pointer move in your project history:

```bash
oms switch api feature/login      # local branch, no remote needed
# ... edit and commit inside oms/api ...
oms push api                      # creates origin/feature/login and stages the pointer
git status                        # shows the staged oms/api pointer update
git commit                        # record the pointer in your project history
```

Omit the alias or branch on `oms switch` and `oms checkout` to pick one interactively — synced submodules, and local or `origin/*` branches respectively.

## How `oms` uses Git submodules

`oms` does not replace Git submodules. It adds a small command layer for the workflow details that make submodules awkward. Submodules already give you a reproducible pin (the parent records each source's exact commit), visibility (`git status` shows when a pointer moved), and history (the pointer travels with your commits). The friction is in everyday branch work, and that is what `oms` smooths over:

- **Start branches locally.** `oms switch <alias> <branch>` starts a local branch right away, even before it exists on the remote. `oms checkout <alias> <branch>` fetches origin and checks out an existing remote branch as a tracking branch. The remote branch is created lazily on your first `oms push`.
- **Stay on a branch.** `oms sync` attaches the baseline branch at the pinned commit instead of leaving a detached HEAD, so everyday submodule work never strands you off a branch.
- **Keep pointer moves visible.** `oms pull` and `oms push` stage the updated gitlink in the parent repo so you can review and commit it, and `oms status` shows when a submodule has drifted from the recorded pointer.

Submodules must **not** be gitignored, since the `oms/<alias>` gitlink is what records each pinned commit. `oms sync` removes a stale `oms/` entry from `.gitignore` if a previous version added one.

> `oms` makes local submodule work easier, but reproducible sharing still requires pushing the source commit and committing the parent pointer.

## Command reference

`oms.yaml` declares each source repo with `alias`, a `remotes` mapping (which must include `origin`), and optional `branch` (the baseline).

| Command | Runs in | Does | Notes |
| --- | --- | --- | --- |
| `oms init` | current directory | Writes a starter `oms.yaml`. | Refuses if `oms.yaml` exists; use `--force`. Does not gitignore `oms/`. |
| `oms doctor` | project root or child path | Checks `oms.yaml`, git availability, that the workspace is a git repo, and each alias's submodule state. | Returns exit 2 if any warning is raised. |
| `oms sync <alias>` / `--all` | workspace root | Registers missing repos with `git submodule add`, initializes registered-but-uninitialized ones, fetches, and attaches the baseline branch. | Reproduces the recorded pointer on a fresh clone. |
| `oms status [alias...]` / `--all` | anywhere under root | Prints branch, pointer state (`ok`/`moved`/`uninit`), dirtiness, and ahead/behind for each submodule. | `moved` means the working commit differs from the recorded pointer — stage/commit it. |
| `oms switch [alias] [branch]` | workspace root | `git switch` to a LOCAL branch, creating it locally if it does not exist yet (no remote required). | `--from <ref>` sets the start point for a new branch. Omit alias/branch to pick interactively (or create a new branch). |
| `oms checkout [alias] [branch]` | workspace root | `git fetch origin --prune`, then check out a REMOTE branch (`origin/*`) as a local tracking branch (or switch to an existing local counterpart). | Omit alias/branch to pick interactively. To create a brand-new local branch, use `oms switch`. |
| `oms fetch ...` | workspace root | `git fetch <remote> --prune` in each submodule. | `--remote <name>` (repeatable) picks the remote(s); omit to choose interactively, defaults to `origin`. |
| `oms pull ...` | workspace root | `git pull --ff-only <remote>` on each submodule's current branch, then stages the moved pointer. | Requires the submodule to be on a branch. `--remote <name>` selects a single remote (defaults to `origin`). |
| `oms push <alias>...` | workspace root | `git push <remote> <branch>` (creating the remote branch on first push), then stages the moved pointer. | `--remote <name>` (repeatable) picks the remote(s), defaults to `origin`; upstream is set only for `origin`. `--commit` also commits the pointer update in the parent. |
| `oms unsync <alias>` / `--all` | workspace root | `git submodule deinit` + `git rm` for the alias; drops an empty `.gitmodules`. | Keeps the `oms.yaml` entry. Use `--force` to discard uncommitted changes. |
| `oms update` | anywhere | Checks the npm registry and safely updates the installed `oms` CLI only when it detects a confident global install. | Use `--check` for a non-mutating check. Use `--yes` to skip the confirmation prompt for confident global updates. Project-local, temporary runner, development, and unknown installs print guidance only. |

## Updating the CLI

Check whether the installed CLI is current:

```bash
oms update --check
```

Run an update when `oms` can confidently identify a global npm, pnpm, Yarn classic, or Bun installation:

```bash
oms update
```

For automation, `--yes` skips the confirmation prompt after `oms` has printed the detected context and selected command:

```bash
oms update --yes
```

`oms update` does not edit project manifests or temporary runner caches. If the install is project-local, temporary, development, or unknown, it prints safe manual guidance instead of mutating the environment.

## `oms.yaml` format

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/divlook/oh-my-space/main/oms.schema.json
repos:
  - alias: service-a
    remotes:
      origin: git@github.com:example/service-a.git
    branch: main
  - alias: docs
    remotes:
      origin: https://github.com/example/docs.git
      upstream: https://github.com/upstream/docs.git
```

Rules:

- `repos` must be a non-empty array.
- `alias` must be unique.
  - Used as the directory name under `oms/<alias>/`.
  - First character: ASCII lowercase letter or digit.
  - Remaining characters: ASCII lowercase letters, digits, `-`, `_`, `@`.
  - Not allowed: uppercase letters, `/`, `\`, `.`, whitespace.
  - Pattern: `/^[a-z0-9][a-z0-9_@-]*$/`.
- `remotes` is required and must include an `origin` entry. Each value is a clonable git URL. `origin` becomes the submodule's primary remote, and additional remotes are configured on `oms sync`.
- `branch` is optional. When omitted, the remote's default branch is used as the baseline.

JSON schema: [`oms.schema.json`](./oms.schema.json) (also reachable at `https://raw.githubusercontent.com/divlook/oh-my-space/main/oms.schema.json` for YAML LSPs).

## Migration guides

Detailed migration steps are organized per version under [`docs/migrations/`](./docs/migrations/).

- [0.7.x → 0.8.0](./docs/migrations/0.7.x-to-0.8.0.md) — splits `oms checkout` into `oms switch` (local branches) and `oms checkout` (remote branches)
- [0.5.x → 0.6.0](./docs/migrations/0.5.x-to-0.6.0.md) — switches the data model from bare clone + worktrees back to git submodules
- [0.3.x → 0.4.0](./docs/migrations/0.3.x-to-0.4.0.md) — renames `sources.yaml`/`sources/` to `oms.yaml`/`oms/`
- [0.2.x → 0.3.0](./docs/migrations/0.2.x-to-0.3.0.md) — (historical) switched submodules to bare clone + worktrees

## Local development

This repository targets the Node.js version in [`.nvmrc`](./.nvmrc) (`24`). After cloning:

```bash
nvm use
npm ci
npm test
```

## License

[MIT](./LICENSE)
