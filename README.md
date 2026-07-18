# oh-my-space

[![npm version](https://img.shields.io/npm/v/oh-my-space.svg)](https://www.npmjs.com/package/oh-my-space)

`oh-my-space` is a small CLI for managing multi-repo workspaces with Git submodule and worktree modes.

Declare repositories once in `oms.yaml`. Choose submodule mode when parent history must pin exact source commits, or worktree mode when you need concurrent named branch checkouts without parent-history pins.

## Choose a mode

| Mode | Best for | Layout | Parent history |
| --- | --- | --- | --- |
| `submodule` (default) | Reproducible source revisions | `oms/<alias>` plus `.gitmodules` | Pins an exact gitlink commit |
| `worktree` | Concurrent branch development | `.oms/repos/<alias>.git` plus `oms/<alias>/<name>` | Does not pin checkout commits |

One mode applies to every alias. Worktree state is local: cloning or checking out the parent repository does not recreate exact worktree revisions.

## When to use it

- You work across several repositories from one project workspace and want them checked out side by side.
- You want each source repo pinned to an exact commit so your workspace stays reproducible.
- You want to stay on a real branch during everyday submodule work instead of landing in a detached HEAD.
- You want pointer changes to show up in `git status` so you can review them before committing.

## Automation-first commands

OMS automates routine, deterministic preparation and bounded recovery whenever it can do so safely. It asks only when a choice depends on intent that cannot be inferred, such as creating missing root submodule topology. If safe completion or a useful degraded result is impossible, the error identifies the failed operation, the state that was preserved, and an actionable OMS command or bounded Git repair.

## Requirements

- [Node.js](https://nodejs.org) `>=20.19.0` to run `oms`.
- Git `>=2.48`; OMS uses relative linked-worktree metadata so a complete workspace can move safely.
- Submodule topology requires `oms.yaml` at the root Git top-level. Worktree mode also supports plain directories and workspaces nested below an enclosing Git root.

## Install

Install `oh-my-space` to use the `oms` command. Install it globally with your package manager of choice:

```bash
npm install -g oh-my-space
pnpm add -g oh-my-space
yarn global add oh-my-space
bun install -g oh-my-space
```

## Quick start

### Submodule mode

Run `oms init` to scaffold a starter `oms.yaml` in your project root, then edit it down to the repositories you need. A minimal one-repo config looks like this:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/divlook/oh-my-space/main/oms.schema.json
repos:
  - alias: api
    remotes:
      origin: git@github.com:example/api.git
    branch: main # optional; defaults to the remote's default branch
```

After scaffolding, `oms init` prints optional AI-setup hints pointing to [`oms agent install`](#ai-agent-workflow) and [`oms skills`](#workspace-skills); both are opt-in and install nothing on their own.

Sync the declared repositories and check their state:

```bash
oms sync --all   # add/initialize every declared repo on its baseline branch
oms status       # branch / pointer / dirty / ahead-behind per submodule
```

Commit and push source work, then run `oms record <alias>` to record the moved parent pointer.

### Worktree mode

```bash
oms init --mode worktree
# edit oms.yaml, then:
oms sync --all
oms worktree add api feature/login
oms worktree list api
oms commit api/feature-login -m "feat: add login"
oms push api/feature-login
```

Worktree mode uses `alias/name` targets and never uses `oms record`.

## Layout

### Submodule layout

A workspace with two declared repositories, `api` and `web`, looks like this:

```
oms.yaml               # declares each source repo (alias, remotes, branch)
.gitmodules            # registers each oms/<alias> -> origin url, branch
oms/
├── api/               # git submodule (a normal working tree, on a branch)
└── web/               # git submodule (a normal working tree, on a branch)
```

`oms.yaml` is your declaration, `.gitmodules` and each `oms/<alias>` gitlink are tracked in your project history, and every directory under `oms/` is a normal checked-out repository you can branch, edit, and commit in.

### Worktree layout

```text
oms.yaml
.oms/
└── repos/
    ├── api.git/        # bare common repository
    └── web.git/
oms/
├── api/
│   ├── main/           # managed target api/main
│   └── feature-login/  # managed target api/feature-login
└── web/
    └── main/
```

Generated common repositories and checkouts are local and excluded from an enclosing parent repository. They follow branches and are not reproducibility pins.

## Command locations and workspace discovery

Workspace-aware commands search from the current directory toward the filesystem root and use the nearest `oms.yaml`. The first `oms.yaml` entry encountered is authoritative. It must be a regular file, or a symbolic link whose target is a regular file. A directory, broken link, link to a non-file target, or invalid nearest manifest causes the command to fail; OMS does not skip it and fall back to an outer workspace.

You can run workspace-aware commands at the workspace root or below it. In submodule mode, a directory below `oms/<alias>/` resolves that alias. In worktree mode, only an ownership-verified checkout below `oms/<alias>/<name>/` resolves the managed `alias/name` target. An explicit alias or target always wins; arbitrary descendants and external worktrees never become managed targets.

Submodule topology commands require the selected manifest directory to be the root Git top-level. Worktree mode supports a plain directory, a Git root, or a workspace nested below an enclosing Git root; that repository is context only and does not own worktree topology. `oms sync --list` is manifest-only and remains available before Git initialization.

## Typical branch flow

In submodule mode, start a branch, commit and push inside the submodule, then record the pointer move:

```bash
oms branch switch api feature/login  # local branch, no remote needed
oms commit api -m "feat: add login"  # commit inside oms/api (submodule only)
oms push api                         # creates origin/feature/login (submodule branch only)
oms record api                       # commit the moved oms/api pointer in your project history
```

`oms commit` and `oms push` stay inside the submodule and never touch the root gitlink; `oms record` is the only command that commits an existing root pointer update. After a successful `oms commit`/`oms pull`/`oms push`, `oms` prints an `oms record <alias>` hint when the pointer has moved. Run `oms status --json` for a machine-readable view of which scope changed.

In worktree mode, create or select a named attached checkout and address source operations by `alias/name`. There is no parent gitlink and `oms record` is unavailable:

```bash
oms worktree add api feature/login --name login
oms commit api/login -m "feat: add login"
oms push api/login
```

Omit the alias or branch on `oms branch switch` and `oms branch checkout` to pick one interactively — synced submodules, and local or `origin/*` branches respectively.

## Listing branches

`oms branch list [alias]` produces a current branch inventory for one declared repository. Use an explicit alias, omit it to select the sole declaration automatically, or choose among multiple aliases interactively:

```bash
oms branch list api
oms branch list
oms branch # choose list, switch, checkout, or delete interactively
```

In submodule mode, listing may initialize an existing registration, reconcile declared remotes, and fetch, so it takes the workspace mutation lock. In worktree mode, listing is a lock-free inspection of existing common local and remote-tracking refs and reports every managed or external checkout location; it never initializes, reconciles, or fetches.

The output identifies the selected alias and detached HEAD when applicable, then prints:

- a `known`, `incomplete`, or `unknown` baseline summary, including reliable baseline names that have no matching local branch;
- a sorted LOCAL table with current/baseline flags, the exact configured upstream, and ahead/behind counts (`?` when an upstream is unavailable);
- a REMOTE table grouped in manifest order, with branch names sorted inside each `fresh`, `stale`, or `unavailable` remote.

When `branch` is omitted from `oms.yaml`, a successful origin fetch refreshes `origin/HEAD`; a failed refresh is reported as baseline uncertainty instead of blocking the inventory. Listing never switches, creates, deletes, merges, or pushes a branch, never changes or records a root gitlink, and never prints an `oms record` hint. An interactive user may explicitly delegate missing topology creation to `oms sync`; otherwise root topology remains unchanged. Exit 1 covers selection or safe-preparation refusal, and exit 2 covers automatic initialization or local-ref inspection failure. Run `oms branch list --help` for the authoritative behavior and examples.

## Deleting a local branch

`oms branch delete [alias] [branch]` removes one **local** branch in the alias repository. In submodule mode that repository is the initialized submodule; in worktree mode it is the owned common repository. It is deliberately narrow and safe:

```bash
oms branch delete api feature/login        # safe delete (git branch -d)
oms branch delete api feature/login --force # force delete (git branch -D)
oms branch delete                           # pick alias, then branch, interactively
oms branch                                  # interactive list/switch/checkout/delete action selector
```

- **Local only.** It never deletes a remote branch or a remote-tracking ref, never fetches or pushes, and never stages or commits the root gitlink. A missing local branch whose name exists on `origin` is reported as local-only.
- **Protected branches.** Every branch checked out by a managed or external worktree and every resolved baseline is protected even with `--force`. Submodule mode also protects reliable `.gitmodules` baseline metadata.
- **Safe by default, one force retry.** A safe `git branch -d` is tried first. If Git rejects it (an unmerged branch) and the branch still exists, an interactive prompt offers a single force retry (default No); a non-interactive shell prints the exact `oms branch delete <alias> <branch> --force` command instead. Before every force deletion OMS prints the branch tip's full OID and a POSIX-shell-safe `git -C oms/<alias> branch <branch> <oid>` recreation command, and re-checks the OID so a branch that moved concurrently aborts (exit 2) rather than losing commits.
- **Preconditions.** Deletion is rejected while a merge/rebase/cherry-pick/revert/bisect/sequencer operation is in progress in the submodule, and for a detached HEAD unless it exactly matches the recorded root gitlink (which lets interrupted automatic initialization resume). Dirty submodule and root state do not block deletion. A registered-but-uninitialized alias named explicitly is initialized automatically (network access limited to that alias) and then revalidated.

## Sync finalization and metadata reconciliation

`oms sync` finalizes topology and OMS-managed `.gitmodules` metadata through **one** decision, and reconciles that metadata from `oms.yaml`:

- **Authoritative manifest metadata.** For an initialized submodule, `oms.yaml` `remotes.origin` is authoritative: sync reconciles the local `origin` URL and the `.gitmodules` `url` to it, and writes an explicit `branch` (or removes the key when omitted). Sync validates the baseline after fetching — an explicit branch must exist on `origin`, and an omitted branch requires a resolvable `origin/HEAD` — and fails that alias otherwise **without** changing its metadata. Output names only the changed fields (`url`, `branch`), never URL values.
- **One finalization.** Reconciled metadata follows the same commit-or-unstage decision as topology: `--commit` (or the interactive default-Yes prompt) records topology and metadata together in one path-limited commit that also includes the complete current working-tree `oms.yaml`; without a commit, the changes are left unstaged.
- **Partial success and isolation.** A `--commit` that partially fails commits only the successful aliases through an owner-only temporary index, preserving unrelated staged paths, and exits non-zero with a summary. The temporary-index commit, a durable fsynced intent marker, and an atomically installed replacement index keep an interrupted commit recoverable: `sync`, `unsync`, and `record` run a shared recovery preflight that completes or safely blocks on leftover finalization state before mutating the root again.

## How `oms` uses Git submodules

`oms` does not replace Git submodules. It adds a small command layer for the workflow details that make submodules awkward. Submodules already give you a reproducible pin (the parent records each source's exact commit), visibility (`git status` shows when a pointer moved), and history (the pointer travels with your commits). The friction is in everyday branch work, and that is what `oms` smooths over:

- **Start branches locally.** `oms branch switch <alias> <branch>` starts a local branch right away, even before it exists on the remote. `oms branch checkout <alias> <branch>` fetches origin and checks out an existing remote branch as a tracking branch. The remote branch is created lazily on your first `oms push`.
- **Stay on a branch.** `oms sync` attaches the baseline branch at the pinned commit instead of leaving a detached HEAD, so everyday submodule work never strands you off a branch.
- **Keep pointer moves visible, commit them explicitly.** `oms pull` and `oms push` synchronize only the submodule branch — they never stage or commit the root gitlink. The moved pointer shows up in `git status`, `oms status` flags when a submodule has drifted from the recorded pointer, and `oms record <alias>` commits that pointer update in the parent repo.

Submodules must **not** be gitignored, since the `oms/<alias>` gitlink is what records each pinned commit. `oms sync` removes a stale `oms/` entry from `.gitignore` if a previous version added one.

> `oms` makes local submodule work easier, but reproducible sharing still requires pushing the source commit (`oms push`) and recording the parent pointer (`oms record`).

## AI agent workflow

When an AI coding agent works in a workspace, the main risk is operating in the wrong Git scope — the root repository versus an `oms/<alias>/` submodule. Two features make that boundary explicit:

- **`oms status --json`** prints exactly one schema-version 2 object on stdout. It reports workspace mode and current target, an optional enclosing root, and mode-discriminated submodule or common-repository/worktree entries. [`oms.status.schema.json`](./oms.status.schema.json) is the normative contract.
- **`oms agent install`** writes a concise, marker-delimited instruction block into `oms/AGENTS.md` and/or `oms/CLAUDE.md`:

  ```bash
  oms agent install --target both   # or: --target agents | --target claude
  ```

  These are **root-repository files under `oms/`, not submodule files**. The managed block is delimited by `<!-- OMS START -->` / `<!-- OMS END -->`; content outside the markers is preserved, and `oms agent uninstall` removes only that block (deleting the file if it becomes empty). The files are created but never staged, so you review and commit them yourself.

## Workspace skills

`oms` publishes three installable agent skills that carry the workspace Git guardrail to sessions started anywhere in the workspace — including at the root, which the [`oms agent install`](#ai-agent-workflow) marker under `oms/` cannot reach. They are installed with the external Vercel Labs `skills` tool (`npx skills`):

```bash
npx skills add divlook/oh-my-space/skills                       # project scope: install at the workspace root
npx skills add divlook/oh-my-space/skills -g                    # global scope: available in every workspace
npx skills add divlook/oh-my-space/skills --skill oms-pointer   # install one skill by name
npx skills add divlook/oh-my-space/skills --list                # list the available skills without installing
```

Project scope is the default and recommended: these skills are only relevant in an `oms.yaml` workspace, so a project install keeps them out of unrelated repositories. `oms skills` prints these commands, and `oms skills --install` runs the project install for you, resolving to the workspace root first and forwarding extra arguments (`-g`, `--skill`, `--list`, `--copy`) straight through.

The three skills are named by the Git domain each manages:

| Skill | Use it when | What it does |
| --- | --- | --- |
| `oms-workspace` | Scope-ambiguous Git work in the workspace — committing from the root, a moved `oms status` pointer, a push, or adding/removing a repo with `oms sync`/`oms unsync`. | Establishes workspace state and root-versus-submodule scope before acting, and separates repo add/remove topology from recording a moved pointer. |
| `oms-pointer` | After `oms commit` or `oms pull` moves a submodule's commit. | Records the moved root pointer with `oms record`, so a submodule change is not left without a recorded pointer and the root pointer is not committed by mistake. |
| `oms-branch` | Starting or switching a branch inside a submodule. | Chooses `oms branch switch` (new local branch) versus `oms branch checkout` (track a remote branch) and avoids detached HEAD. |

Skill firing is best-effort — an agent loads a skill only when it judges the skill's description relevant — so the skills complement, rather than replace, `oms <command> --help` and the always-on marker block inside `oms/`. Each skill defers exact `oms status --json` field semantics to `oms status --help`, the version-matched authoritative source that ships with the installed CLI.

## Command reference

`oms.yaml` declares each source repo with `alias`, a `remotes` mapping (which must include `origin`), and optional `branch` (the baseline).

| Command | Runs in | Does | Notes |
| --- | --- | --- | --- |
| `oms init` | current directory | Writes a starter `oms.yaml`. | Defaults to submodule mode; `--mode worktree` also permits a nested or plain directory. |
| `oms doctor` | workspace root or child path | Read-only mode-aware ownership, lock, transition, endpoint, repository, worktree, exclude, orphan, and topology diagnostics. | Returns exit 2 if any warning is raised and never repairs or prunes. |
| `oms sync <alias>` / `--all` | workspace root | Provisions submodules or owned common repositories and first worktrees, then refreshes declared remotes. | Worktree sync never advances local branches or recreates intentionally removed checkouts. |
| `oms status [alias|alias/name]` / `--all` | anywhere under root | Prints mode-aware repository and checkout state. | `--json` emits status schema v2; worktree mode accepts compound target filters. |
| `oms worktree add|list|move|remove` | worktree workspace | Manages named attached checkouts or lists managed and external registrations. | Mutation commands use `alias/name`; list is read-only. |
| `oms commit [alias|alias/name]` | workspace root or selected checkout | Commits source changes inside one selected repository checkout. | Worktree mode never creates or hints at a root pointer record. |
| `oms record [alias]` | submodule workspace | Commits an existing root gitlink pointer update. | Rejected in worktree mode because no parent pointer exists. |
| `oms branch switch [alias] [branch]` | workspace root | `git switch` to a LOCAL branch, creating it locally if it does not exist yet (no remote required). | `--from <ref>` sets the start point for a new branch. Omit alias/branch to pick interactively (or create a new branch). |
| `oms branch checkout [alias] [branch]` | workspace root | `git fetch origin --prune`, then check out a REMOTE branch (`origin/*`) as a local tracking branch (or switch to an existing local counterpart). | Omit alias/branch to pick interactively. To create a brand-new local branch, use `oms branch switch`. |
| `oms branch list [alias]` | workspace root | Lists alias-scoped local and remote-tracking branches. | Worktree mode is lock-free and includes managed/external checkout locations; submodule mode may refresh under the mutation lock. |
| `oms branch delete [alias] [branch]` | workspace root | Deletes one local branch with safe or forced Git semantics. | Protects baselines and every managed/external checked-out branch. |
| `oms fetch ...` | workspace root | Refreshes declared remotes at alias scope. | Worktree mode defaults to every declared remote and aggregates operational failures as exit 2. |
| `oms pull ...` | workspace root or selected checkout | Fast-forwards one selected checkout, or every managed worktree with `--all`. | Worktree `--all` excludes external worktrees and aggregates operational failure before safety refusal. |
| `oms push ...` | workspace root or selected checkout | Pushes the selected checkout branch to declared remotes. | Worktree mode uses a declared upstream first and never changes a root pointer. |
| `oms unsync <alias>` / `--all` | workspace root | Removes owned submodule or worktree topology after mode-specific publication and safety checks. | Worktree mode blocks external or locked registrations even with force and preserves explicit orphan state unless named directly. |
| `oms agent install` / `uninstall` | workspace root | Manages a marker-delimited OMS instruction block in `oms/AGENTS.md` and/or `oms/CLAUDE.md` (root-repo files). | `--target agents\|claude\|both` (omit to choose interactively). Does not stage files. See [AI agent workflow](#ai-agent-workflow). |
| `oms skills` | anywhere (`--install` resolves to root) | Prints the `npx skills add divlook/oh-my-space/skills` commands (project scope and `-g` global) to install the workspace skills. | `--install` delegates to `npx skills add`, forwarding extra args (`-g`, `--skill <name>`, `--list`). Run outside a workspace without `-g`, it errors and points to the global install. See [Workspace skills](#workspace-skills). |
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
- `mode` is optional and defaults to `submodule`; `worktree` applies to every repository in the workspace.
- `remotes` is required and must include `origin`. In worktree mode, credential-bearing URL components, query/fragment components, and executable transports are rejected; use a credential helper or SSH agent.
- `branch` is optional. When omitted, the remote's default branch is used as the baseline.

JSON schema: [`oms.schema.json`](./oms.schema.json) (also reachable at `https://raw.githubusercontent.com/divlook/oh-my-space/main/oms.schema.json` for YAML LSPs).

## Migration guides

Detailed migration steps are organized per version under [`docs/migrations/`](./docs/migrations/).

- [Worktree mode and status v2](./docs/migrations/worktree-mode-and-status-v2.md) — covers Git 2.48, status schema v2, explicit mode transitions, and rollback limits

- [0.13.x → 0.14.0](./docs/migrations/0.13.x-to-0.14.0.md) — relocates `oms switch` / `oms checkout` under the `oms branch` group as `oms branch switch` / `oms branch checkout` (top-level commands removed, no aliases)
- [0.11.x → 0.12.0](./docs/migrations/0.11.x-to-0.12.0.md) — adds `oms branch delete` and makes `oms sync` reconcile declarative `.gitmodules` metadata with stricter baseline validation and a durable finalization recovery preflight
- [0.9.x → 0.10.0](./docs/migrations/0.9.x-to-0.10.0.md) — scopes each command to a single Git boundary and makes root pointer commits explicit via `oms record`
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
