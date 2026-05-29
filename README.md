# oh-my-space

`oh-my-space` provides the `oms` CLI for managing external source repositories declared in `oms.yaml`. Each registered repo is checked out as a **git submodule** at `oms/<alias>/`, so its pinned commit, branch, and history are tracked natively by your project — and `oms` wraps the submodule foot-guns (detached HEAD, remote-first branch creation, easy-to-miss pointer moves) behind a small, friendly command set.

Package name: `oh-my-space`

Command name: `oms`

## Why submodules + a wrapper

Git submodules give you three things for free: a **reproducible pin** (the parent records each source's exact commit), **visibility** (`git status` shows when a pointer moved), and **history** (the pointer travels with your commits). What they make awkward is day-to-day branch work. `oms` keeps the native benefits and removes the friction:

- **Create a new branch locally, with no remote precondition.** `oms checkout <alias> <branch>` makes the branch right away even if it does not exist on the remote yet. The remote branch is created lazily on your first `oms push`.
- **Always on a branch, never detached.** `oms sync` attaches the baseline branch at the pinned commit instead of leaving a detached HEAD.
- **Pointer moves stay visible.** `oms pull` / `oms push` stage the updated gitlink in the parent so you can see and commit it; `oms status` surfaces drift.

> Sharing a pin with your team still requires pushing the commit — that is inherent to any pinning model. `oms` removes the *local* friction; it cannot make an unpushed commit reproducible for others.

## Requirements

- [Node.js](https://nodejs.org) `>=20.19.0` for running `oms`; development uses the version in `.nvmrc` (`24`)
- git `>=2.40` (`git switch` + submodule commands)
- The workspace must be a git repository (`git init`), since sources are submodules of it.

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

Run `oms init` to scaffold a starter `oms.yaml`, or create one by hand in your project root:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/divlook/oh-my-space/main/oms.schema.json
repos:
  - alias: api
    remotes:
      origin: git@github.com:example/api.git
    branch: main
  - alias: web
    remotes:
      origin: git@github.com:example/web.git
      upstream: git@github.com:upstream/web.git
```

Sync and work:

```bash
oms init                          # scaffold a starter oms.yaml
oms doctor                        # validate oms.yaml + submodule state
oms sync --list                   # list registered source repos
oms sync <alias>...               # add/initialize submodules on their baseline branch
oms sync --all                    # sync every registered source repo
oms status                        # branch / pointer / dirty / ahead-behind per submodule
oms checkout <alias> <branch>     # switch (or create a brand-new local branch)
oms push <alias>...               # push the branch (lazy remote) + stage the pointer
oms push <alias> --remote upstream  # target a specific remote (repeatable; defaults to origin)
oms unsync <alias>...             # deinitialize and remove a submodule
```

A typical new-branch flow:

```bash
oms checkout api feature/login    # local branch, no remote needed
# ... edit, commit inside oms/api ...
oms push api                      # creates origin/feature/login and stages the pointer
git add oms/api && git commit     # record the pointer in your project history
```

## Layout

For an alias `api` checked out on `main`:

```
.gitmodules            # registers oms/api -> origin url, branch
oms/
└── api/               # git submodule (a normal working tree, on a branch)
```

`.gitmodules` and the `oms/<alias>` gitlink are part of your project history. Submodules must **not** be gitignored; `oms sync` removes a stale `oms/` entry from `.gitignore` if a previous version added one.

## Managing source repositories

`oms.yaml` declares each source repo with `alias`, a `remotes` mapping (which must include `origin`), and optional `branch` (the baseline).

| Command | Runs in | Does | Notes |
| --- | --- | --- | --- |
| `oms init` | current directory | Writes a starter `oms.yaml`. | Refuses if `oms.yaml` exists; use `--force`. Does not gitignore `oms/`. |
| `oms doctor` | project root or child path | Checks `oms.yaml`, git availability, that the workspace is a git repo, and each alias's submodule state. | Returns exit 2 if any warning is raised. |
| `oms sync <alias>` / `--all` | workspace root | Registers missing repos with `git submodule add`, initializes registered-but-uninitialized ones, fetches, and attaches the baseline branch. | Reproduces the recorded pointer on a fresh clone. |
| `oms status [alias...]` / `--all` | anywhere under root | Prints branch, pointer state (`ok`/`moved`/`uninit`), dirtiness, and ahead/behind for each submodule. | `moved` means the working commit differs from the recorded pointer — stage/commit it. |
| `oms checkout <alias> <branch>` | workspace root | `git switch` to the branch; creates it locally if it exists nowhere yet (no remote required). | `--from <ref>` sets the start point for a new branch. |
| `oms fetch ...` | workspace root | `git fetch <remote> --prune` in each submodule. | `--remote <name>` (repeatable) picks the remote(s); omit to choose interactively, defaults to `origin`. |
| `oms pull ...` | workspace root | `git pull --ff-only <remote>` on each submodule's current branch, then stages the moved pointer. | Requires the submodule to be on a branch. `--remote <name>` selects a single remote (defaults to `origin`). |
| `oms push <alias>...` | workspace root | `git push <remote> <branch>` (creating the remote branch on first push), then stages the moved pointer. | `--remote <name>` (repeatable) picks the remote(s), defaults to `origin`; upstream is set only for `origin`. `--commit` also commits the pointer update in the parent. |
| `oms unsync <alias>` / `--all` | workspace root | `git submodule deinit` + `git rm` for the alias; drops an empty `.gitmodules`. | Keeps the `oms.yaml` entry. Use `--force` to discard uncommitted changes. |

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
- `alias` must be unique and match `/^[a-z0-9][a-z0-9-]*$/`.
- `remotes` is required and must include an `origin` entry; each value is a clonable git URL. `origin` becomes the submodule's primary remote, and additional remotes are configured on `oms sync`.
- `branch` is optional; when omitted the remote's default branch is used as the baseline.

JSON schema: [`oms.schema.json`](./oms.schema.json) (also reachable at `https://raw.githubusercontent.com/divlook/oh-my-space/main/oms.schema.json` for YAML LSPs).

## Migrating between versions

Detailed migration steps are organized per version under [`docs/migrations/`](./docs/migrations/).

- [0.5.x → 0.6.0](./docs/migrations/0.5.x-to-0.6.0.md) — switches the data model from bare clone + worktrees back to git submodules
- [0.3.x → 0.4.0](./docs/migrations/0.3.x-to-0.4.0.md) — renames `sources.yaml`/`sources/` to `oms.yaml`/`oms/`
- [0.2.x → 0.3.0](./docs/migrations/0.2.x-to-0.3.0.md) — (historical) switched submodules to bare clone + worktrees

## License

[MIT](./LICENSE)
