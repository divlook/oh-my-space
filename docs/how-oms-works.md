# How OMS works

OMS keeps source repositories beside one another. The main project records each source repository's exact commit. This page explains repository boundaries and safety rules for everyday work and recovery.

## Workspace layout

A workspace with `api` and `web` looks like this:

```text
oms.yaml               # declares each source repository
.gitmodules            # registers each oms/<alias> Git submodule
oms/
├── api/               # normal Git working tree
└── web/               # normal Git working tree
.oms-tree/             # machine-local task trees (not committed)
```

See [Managed trees](#managed-trees) for machine-local task worktrees under `.oms-tree/`.

`oms.yaml` is the declaration. The main project tracks `.gitmodules` and each `oms/<alias>` entry. Each directory under `oms/` is a separate Git repository where you can branch, edit, commit, pull, and push.

Do not add `oms/` to `.gitignore`. The submodule entry is how the main project records each source repository's exact commit. `oms sync` removes the stale `oms/` ignore entry created by older OMS versions.

## Two Git boundaries

Every source change crosses two deliberate boundaries:

1. Commit the source change inside `oms/<alias>/`.
2. Push the source commit.
3. Record the new source commit in the main project with `oms record <alias>`.

`oms commit`, `oms pull`, and `oms push` operate in the source repository only. They never stage or commit the main project's submodule entry. `oms record` is the command that commits an existing pointer update in the main project.

The exact submodule commit stored by the main project is the **recorded commit**. A source checkout can move to another commit. `git status` and `oms status` show that change until you record it.

## Managed trees

A **managed tree** is a disposable Git worktree at `.oms-tree/<alias>/<task>/`. It uses the submodule's Git directory and shares its history, branches, remotes, and objects.

Create a managed tree with `oms tree add <alias> <task>`. Managed trees support concurrent tasks without task-specific aliases or extra clones. A new `<task>` branch starts at the canonical checkout's HEAD, or at `--from <ref>`. OMS never moves the canonical checkout.

Adding, listing, and removing trees creates no root commit, `.gitmodules` entry, or gitlink. Task checkouts never enter shared root history.

OMS excludes `.oms-tree/` from root status through the root's local `.git/info/exclude` file. OMS never adds a tracked `.gitignore` entry because that entry requires a root commit. Trees are machine-local. A teammate's fresh clone does not contain them.

Use plain Git inside a managed tree. OMS alias commands (`commit`, `record`, `branch`, `fetch`, `pull`, `push`) refuse to run there.

Use this pull-request workflow to return the merged result to the canonical checkout:

1. Commit the `<task>` branch changes inside the tree.
2. Push the `<task>` branch.
3. Open its pull request.
4. After the pull request merges, run `oms pull <alias>` in the canonical checkout to move the submodule branch.
5. Run `oms record <alias>` to commit the moved root pointer.

`oms tree remove <alias> <task>` deletes only the worktree. The `<task>` branch and its commits remain. Branch deletion requires a separate `oms branch delete` decision.

`oms unsync` refuses while any tree exists for the alias. Unsync deletes the shared submodule Git directory that those trees use.

`oms status` reports every tree under `.oms-tree/`, including the `trees` array in JSON. `oms doctor` reports broken tree links, for example after you move the workspace root. It recommends `git worktree repair`.

## Workspace discovery

Workspace-aware commands search upward from the current directory and use the nearest `oms.yaml`. OMS treats the nearest entry as authoritative. OMS does not skip an invalid manifest to use an outer workspace.

The manifest must be a regular file or a symbolic link to a regular file. Commands that inspect or change submodules require the manifest directory to be the main Git repository's top level. This prevents a nested manifest from changing the wrong `.gitmodules`, index, or `oms/` directory.

You can run workspace-aware commands at the root or below it. Inside a declared `oms/<alias>/`, OMS can infer the alias for commands such as `oms commit` and `oms record`. An explicit alias always wins. Other descendants can discover the workspace but do not become a current alias.

`oms sync --list` only reads the manifest, so it remains available before Git initialization.

## Synchronization

`oms sync` makes the registered workspace match `oms.yaml` without silently advancing source code:

- OMS registers missing repositories with `git submodule add`.
- OMS initializes registered but uninitialized repositories at the commit recorded by the main project.
- OMS reconciles declared remotes. `remotes.origin` controls both the local `origin` URL and the `.gitmodules` URL.
- An explicit `branch` becomes the baseline. If the manifest omits `branch`, OMS uses the remote's default branch.
- OMS attaches the baseline branch only when this preserves the checked-out commit.

The remote baseline can advance beyond the recorded commit. In this case, synchronization preserves the checkout at the recorded commit and explains how to switch and pull. A fresh clone remains reproducible. Synchronization does not implicitly update source code.

By default, OMS commits repository registration and OMS-managed `.gitmodules` changes in one path-limited main-project commit. Use `--no-commit` to leave those changes unstaged. A failed baseline check leaves the alias's metadata unchanged. OMS reports the failure without printing remote URLs.

## Registration and preparation

Commands classify the selected alias before working:

- **Registered and initialized:** Commands continue normally.
- **Registered but uninitialized:** Commands initialize the repository without changing the main project's registered paths. They then continue.
- **Declared but unregistered:** Read-only or fetch-like workflows may offer `oms sync`. Commit, push, branch deletion, and other commands that require existing local work refuse. A fresh checkout cannot contain that work.
- **Partially or inconsistently registered:** Commands refuse and direct you to `oms sync`. They do not guess which state is correct.

OMS never registers a repository silently. In a non-interactive session, an operation that needs your decision fails without changing the registered workspace.

Before commit, pull, or push, OMS may attach a detached checkout to a local branch that points to the same commit. A **detached HEAD** means Git uses a commit directly instead of a branch. If attachment requires a different commit, OMS asks first or prints `oms branch switch` guidance.

## Status

`oms status` reports each repository's branch, dirtiness, ahead/behind state, and pointer state:

- `ok`: checked out at the recorded commit.
- `moved`: The checkout uses a different commit. Use `oms record` after the source commit is available remotely.
- `uninit`: registered but not initialized.
- `missing`: expected repository state is absent.
- `conflict`: the main-project submodule entry is conflicted.

`oms status --json` emits one schema-versioned JSON object for tools and AI agents. It includes the workspace root, current alias, recorded pointers, and source-repository state. Run `oms status --help` for the authoritative field contract.

## Branch safety

`oms branch delete` removes only one local source-repository branch. It never deletes remote or remote-tracking branches and never changes the recorded commit.

OMS protects the current branch and every reliably resolved baseline, including both sides of baseline metadata drift. OMS refuses ambiguous or malformed baseline metadata to protect branches. OMS also refuses deletion during a merge, rebase, cherry-pick, revert, bisect, or sequencer operation.

Safe deletion uses Git's merged-branch check first. Force deletion requires an explicit choice. Before force deletion, OMS prints the branch tip and a recreation command. OMS then checks the tip again. If another process moves the branch, OMS stops deletion to preserve the unexpected commit.

## Partial success and preserved state

Multi-repository operations isolate failures by alias and summarize partial success. Root finalization records only successful aliases and preserves unrelated staged paths.

When finalizing repository registration or metadata, OMS writes durable recovery state before replacing the main index. If interruption leaves finalization state behind, `oms sync`, `oms unsync`, and `oms record` run a shared recovery preflight. They either complete the known operation safely or stop before making another main-project change.

OMS limits automation to user intent. OMS performs deterministic preparation, but asks before choices such as registering a missing repository. When OMS cannot continue safely, the error names the failed operation and describes preserved state. The error points to an OMS command or limited Git repair.

## Recovery checklist

1. Run `oms status` to identify the affected repository and Git boundary.
2. Run `oms doctor` to diagnose the manifest, Git-root identity, registrations, and installed skill versions.
3. Follow the specific `oms sync`, `oms branch switch`, or `oms record` command printed by the failure.
4. Use manual Git repair only when the error explicitly requires it.
5. Limit the repair to the named repository and paths.

See [Commands](commands.md) to choose a command. Exact flags and exit behavior remain authoritative in `oms <command> --help`.
