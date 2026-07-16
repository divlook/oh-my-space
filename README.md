# oh-my-space

[![npm version](https://img.shields.io/npm/v/oh-my-space.svg)](https://www.npmjs.com/package/oh-my-space)

`oh-my-space` is a small CLI for managing multi-repo workspaces with Git submodules.

Declare external repositories in `oms.yaml` and sync them into `oms/<alias>/`. Your parent project records each repo's exact commit while you work with normal branch, pull, and push flows.

## When to use it

- You work across several repositories from one project workspace and want them checked out side by side.
- You want each source repo pinned to an exact commit so your workspace stays reproducible.
- You want to stay on a real branch during everyday submodule work instead of landing in a detached HEAD.
- You want pointer changes to show up in `git status` so you can review them before committing.

## Automation-first commands

OMS automates routine, deterministic preparation and bounded recovery whenever it can do so safely. It asks only when a choice depends on intent that cannot be inferred, such as creating missing root submodule topology. If safe completion or a useful degraded result is impossible, the error identifies the failed operation, the state that was preserved, and an actionable OMS command or bounded Git repair.

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

After scaffolding, `oms init` prints optional AI-setup hints pointing to [`oms agent install`](#ai-agent-workflow) and [`oms skills`](#workspace-skills); both are opt-in and install nothing on their own.

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

Start a branch, commit inside the submodule, push it, then record the pointer move in your project history. Each command stays in a single Git scope:

```bash
oms branch switch api feature/login  # local branch, no remote needed
oms commit api -m "feat: add login"  # commit inside oms/api (submodule only)
oms push api                         # creates origin/feature/login (submodule branch only)
oms record api                       # commit the moved oms/api pointer in your project history
```

`oms commit` and `oms push` stay inside the submodule and never touch the root gitlink; `oms record` is the only command that commits an existing root pointer update. After a successful `oms commit`/`oms pull`/`oms push`, `oms` prints an `oms record <alias>` hint when the pointer has moved. Run `oms status --json` for a machine-readable view of which scope changed.

Omit the alias or branch on `oms branch switch` and `oms branch checkout` to pick one interactively — synced submodules, and local or `origin/*` branches respectively.

## Listing branches

`oms branch list [alias]` produces a current branch inventory for one declared submodule. Use an explicit alias, omit it to select the sole declaration automatically, or choose among multiple aliases interactively:

```bash
oms branch list api
oms branch list
oms branch # choose list, switch, checkout, or delete interactively
```

Before listing, OMS safely initializes an existing registered submodule when needed, reconciles every remote declared for that alias in `oms.yaml`, and runs `git fetch <remote> --prune` sequentially in manifest order. A failed fetch is retried once. If both attempts fail, cached refs remain visible as `stale`; a failed remote without usable refs is `unavailable`. These degraded states still exit 0 when local refs can be inspected. Extra local remotes are not fetched or included in the remote inventory, although an actual configured upstream on one of them remains visible for its local branch.

The output identifies the selected alias and detached HEAD when applicable, then prints:

- a `known`, `incomplete`, or `unknown` baseline summary, including reliable baseline names that have no matching local branch;
- a sorted LOCAL table with current/baseline flags, the exact configured upstream, and ahead/behind counts (`?` when an upstream is unavailable);
- a REMOTE table grouped in manifest order, with branch names sorted inside each `fresh`, `stale`, or `unavailable` remote.

When `branch` is omitted from `oms.yaml`, a successful origin fetch refreshes `origin/HEAD`; a failed refresh is reported as baseline uncertainty instead of blocking the inventory. Listing never switches, creates, deletes, merges, or pushes a branch, never changes or records a root gitlink, and never prints an `oms record` hint. An interactive user may explicitly delegate missing topology creation to `oms sync`; otherwise root topology remains unchanged. Exit 1 covers selection or safe-preparation refusal, and exit 2 covers automatic initialization or local-ref inspection failure. Run `oms branch list --help` for the authoritative behavior and examples.

## Deleting a local branch

`oms branch delete [alias] [branch]` removes one **local** branch inside a single initialized submodule. It is deliberately narrow and safe:

```bash
oms branch delete api feature/login        # safe delete (git branch -d)
oms branch delete api feature/login --force # force delete (git branch -D)
oms branch delete                           # pick alias, then branch, interactively
oms branch                                  # interactive list/switch/checkout/delete action selector
```

- **Local only.** It never deletes a remote branch or a remote-tracking ref, never fetches or pushes, and never stages or commits the root gitlink. A missing local branch whose name exists on `origin` is reported as local-only.
- **Protected branches.** The current branch and every resolved baseline are protected and cannot be deleted, even with `--force`. Baselines are the explicit `oms.yaml` `branch`, or the remote default (`origin/HEAD`) when `branch` is omitted, plus any branch recorded for the alias in a present, reliable `.gitmodules` version (working tree, index, or `HEAD`). Drift between these is reported and both are protected; a later `oms sync` reconciles the metadata. Unreadable, malformed, duplicate, or multi-valued baseline metadata fails closed with the offending source named.
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

- **`oms status --json`** prints exactly one machine-readable JSON object on stdout (schema-versioned) describing the workspace root, the current alias, root submodule pointers, and each submodule's branch, dirtiness, and ahead/behind state. An agent can inspect it before deciding where to branch or commit.
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
| `oms init` | current directory | Writes a starter `oms.yaml`. | Refuses if `oms.yaml` exists; use `--force`. Does not gitignore `oms/`. |
| `oms doctor` | project root or child path | Checks `oms.yaml`, git availability, that the workspace is a git repo, and each alias's submodule state. | Returns exit 2 if any warning is raised. |
| `oms sync <alias>` / `--all` | workspace root | Registers missing repos with `git submodule add`, initializes registered-but-uninitialized ones, fetches, and attaches the baseline branch. | Reproduces the recorded pointer on a fresh clone. Topology changes (`.gitmodules`, `oms/<alias>`) are left unstaged by default; commit them via the prompt or `--commit` (`chore(oms): add ...`). |
| `oms status [alias...]` / `--all` | anywhere under root | Prints branch, pointer state (`ok`/`moved`/`uninit`/`missing`/`conflict`), dirtiness, and ahead/behind for each submodule. | `moved` means the working commit differs from the recorded pointer — record it with `oms record`. `--json` prints one machine-readable object on stdout for tooling and agents. |
| `oms commit [alias]` | workspace root or inside `oms/<alias>/` | Commits source changes inside the selected submodule only; never the root gitlink. | `-m <message>` is required (repeatable). Commits existing staged changes as-is, otherwise stages all with `git add -A`. Infers the alias from the current `oms/<alias>/` directory. |
| `oms record [alias]` | workspace root or inside `oms/<alias>/` | Commits an existing root gitlink pointer update for one alias (`chore(oms): update <alias> submodule to <sha>`). | Root repo only, path-limited to `oms/<alias>`; refuses unrelated staged changes. Not for adds/removals — use `oms sync`/`oms unsync`. |
| `oms branch switch [alias] [branch]` | workspace root | `git switch` to a LOCAL branch, creating it locally if it does not exist yet (no remote required). | `--from <ref>` sets the start point for a new branch. Omit alias/branch to pick interactively (or create a new branch). |
| `oms branch checkout [alias] [branch]` | workspace root | `git fetch origin --prune`, then check out a REMOTE branch (`origin/*`) as a local tracking branch (or switch to an existing local counterpart). | Omit alias/branch to pick interactively. To create a brand-new local branch, use `oms branch switch`. |
| `oms branch list [alias]` | workspace root | Safely prepares one declared submodule, refreshes all declared remotes, and lists local and remote-tracking branches. | Shows baseline certainty, current/baseline flags, exact upstream divergence, detached HEAD, and per-remote `fresh`/`stale`/`unavailable` state. Never switches a branch or changes a root gitlink outside an explicitly accepted `oms sync`. |
| `oms branch delete [alias] [branch]` | workspace root | Deletes one LOCAL branch inside one initialized submodule with `git branch -d` (safe) or `-D` (`--force`). | Local only — never deletes a remote or remote-tracking ref, never touches the root gitlink. Protects the current branch and every resolved baseline (see below). Omit alias/branch to pick interactively; a registered-but-uninitialized alias is initialized first. Exit 0 on success, 1 on input/precondition errors, 2 on a declined/failed/concurrent deletion. |
| `oms fetch ...` | workspace root | `git fetch <remote> --prune` in each submodule. | `--remote <name>` (repeatable) picks the remote(s); omit to choose interactively, defaults to `origin`. |
| `oms pull ...` | workspace root | `git pull --ff-only <remote>` on each submodule's current branch. | Submodule branch only — never stages or commits the root gitlink. Rejects a dirty submodule; prints an `oms record <alias>` hint when the pointer moves. `--remote <name>` selects a single remote (defaults to `origin`). |
| `oms push <alias>...` | workspace root | `git push <remote> <branch>` (creating the remote branch on first push). | Submodule branch only — never stages or commits the root gitlink. `--commit`/`--record` are unsupported; record the root pointer with `oms record <alias>`. `--remote <name>` (repeatable) picks the remote(s); upstream is set only for `origin`. |
| `oms unsync <alias>` / `--all` | workspace root | `git submodule deinit` + `git rm` for the alias; drops an empty `.gitmodules`. | Keeps the `oms.yaml` entry. Use `--force` to discard uncommitted changes. Removal topology is left unstaged by default; commit via the prompt or `--commit` (`chore(oms): remove ...`). |
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
- `remotes` is required and must include an `origin` entry. Each value is a clonable git URL. `origin` becomes the submodule's primary remote, and additional remotes are configured on `oms sync`.
- `branch` is optional. When omitted, the remote's default branch is used as the baseline.

JSON schema: [`oms.schema.json`](./oms.schema.json) (also reachable at `https://raw.githubusercontent.com/divlook/oh-my-space/main/oms.schema.json` for YAML LSPs).

## Migration guides

Detailed migration steps are organized per version under [`docs/migrations/`](./docs/migrations/).

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
