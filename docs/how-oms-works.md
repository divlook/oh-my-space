# How OMS works

OMS keeps several source repositories beside one another while the main project records the exact commit used from each repository. This page explains the boundaries and safety rules that affect everyday work and recovery.

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

`.oms-tree/` holds **managed trees**: disposable per-task Git worktrees at `.oms-tree/<alias>/<task>/`, created with `oms tree add`. A tree shares its submodule's history (branches, remotes, objects) but has its own working tree checked out on the `<task>` branch. Trees are excluded from root status through the root's local exclude file (`.git/info/exclude`) rather than a tracked `.gitignore` entry, so a teammate's fresh clone never sees the directory: trees are machine-local by design, and creating or removing one makes no root commit and no `.gitmodules` change.

`oms.yaml` is the declaration. `.gitmodules` and each `oms/<alias>` entry are tracked by the main project. Each directory under `oms/` is a separate Git repository where you can branch, edit, commit, pull, and push.

Do not add `oms/` to `.gitignore`. The submodule entry is how the main project records each source repository's exact commit. `oms sync` removes the stale `oms/` ignore entry created by older OMS versions.

## Two Git boundaries

Every source change crosses two deliberate boundaries:

1. Commit and push the source change inside `oms/<alias>/`.
2. Record the new source commit in the main project with `oms record <alias>`.

`oms commit`, `oms pull`, and `oms push` operate in the source repository only. They never stage or commit the main project's submodule entry. `oms record` is the command that commits an existing pointer update in the main project.

The exact submodule commit stored by the main project is the **recorded commit**. If a checked-out source repository moves to another commit, `git status` and `oms status` keep that change visible until you record it.

## Managed trees

A **managed tree** is a disposable Git worktree at `.oms-tree/<alias>/<task>/` layered on the submodule's own Git directory, created with `oms tree add <alias> <task>`. It exists so several tasks can proceed in one repository without registering task-specific aliases or cloning extra copies: the tree shares the submodule's branches and remotes, starts its own `<task>` branch at the canonical checkout's HEAD (or at `--from <ref>`), and never moves the canonical checkout. The whole tree lifecycle — add, list, remove — creates no root commit, no `.gitmodules` entry, and no gitlink, so task checkouts never enter shared root history.

The exclusion is local-only: `.oms-tree/` stays out of root status through the root's `.git/info/exclude`, never through a tracked `.gitignore` entry, because a tracked entry would itself be a root commit. Trees are therefore machine-local and invisible to teammates.

Work inside a tree with plain Git — `oms` alias commands (`commit`, `record`, `branch`, `fetch`, `pull`, `push`) refuse to run there. The PR-centric flow reflects the merged result back into the canonical checkout:

1. Commit and push the `<task>` branch from inside the tree, and open its pull request.
2. After the PR merges, run `oms pull <alias>` in the canonical checkout to move the submodule branch.
3. Run `oms record <alias>` to commit the moved root pointer.

Removing a tree with `oms tree remove <alias> <task>` deletes only the worktree; the `<task>` branch and its commits survive, and branch deletion stays a separate `oms branch delete` decision. `oms unsync` refuses while any tree exists for the alias, because unsync deletes the shared submodule Git directory the trees are attached to. `oms status` reports every tree under `.oms-tree/` (the `trees` array in JSON), and `oms doctor` reports broken tree links — for example after moving the workspace root — with `git worktree repair` as the remediation.

## Workspace discovery

Workspace-aware commands search upward from the current directory and use the nearest `oms.yaml`. The nearest entry is authoritative: OMS does not skip an invalid manifest and fall back to an outer workspace.

The manifest must be a regular file, or a symbolic link to a regular file. Commands that inspect or change submodules also require its directory to be the top level of the main Git repository. This prevents a nested manifest from changing the wrong `.gitmodules`, index, or `oms/` directory.

You can run workspace-aware commands at the root or below it. Inside a declared `oms/<alias>/`, OMS can infer that alias for commands such as `oms commit` and `oms record`; an explicit alias always wins. Other descendants can discover the workspace but do not become a current alias.

`oms sync --list` only reads the manifest, so it remains available before Git initialization.

## Synchronization

`oms sync` makes the registered workspace match `oms.yaml` without silently advancing source code:

- Missing repositories are registered with `git submodule add`.
- Registered but uninitialized repositories are initialized at the commit recorded by the main project.
- Declared remotes are reconciled. `remotes.origin` controls both the local `origin` URL and the `.gitmodules` URL.
- An explicit `branch` becomes the baseline. If it is omitted, OMS uses the remote's default branch.
- The baseline branch is attached only when doing so does not move the checked-out commit.

If the remote baseline has advanced beyond the recorded commit, synchronization preserves the checkout at the recorded commit and explains how to switch and pull. This keeps a fresh clone reproducible instead of turning synchronization into an implicit update.

Repository registration and OMS-managed `.gitmodules` changes are committed by default in one path-limited main-project commit. Use `--no-commit` to leave those changes unstaged. A failed baseline check leaves that alias's metadata unchanged and reports the failure without printing remote URLs.

## Registration and preparation

Commands classify the selected alias before working:

- **Registered and initialized:** continue normally.
- **Registered but uninitialized:** initialize it without changing the main project's registered paths, then continue.
- **Declared but unregistered:** read-only or fetch-like workflows may offer `oms sync`; commands that require existing local work, such as commit, push, or branch deletion, refuse because a fresh checkout cannot contain that work.
- **Partially or inconsistently registered:** refuse and direct you to `oms sync` rather than guessing which state is correct.

OMS never registers a repository silently. In a non-interactive session, an operation that needs your decision fails without changing the registered workspace.

Before commit, pull, or push, OMS may attach a detached checkout to a local branch only when that branch points to the same commit. A **detached HEAD** means Git has checked out a commit directly instead of a branch. If attaching would move the checkout, OMS asks first or prints `oms branch switch` guidance.

## Status

`oms status` reports each repository's branch, dirtiness, ahead/behind state, and pointer state:

- `ok`: checked out at the recorded commit.
- `moved`: checked out at a different commit; use `oms record` after the source commit is available remotely.
- `uninit`: registered but not initialized.
- `missing`: expected repository state is absent.
- `conflict`: the main-project submodule entry is conflicted.

`oms status --json` emits one schema-versioned JSON object for tools and AI agents. It includes the workspace root, current alias, recorded pointers, and source-repository state. Run `oms status --help` for the authoritative field contract.

## Branch safety

`oms branch delete` removes only one local source-repository branch. It never deletes remote or remote-tracking branches and never changes the recorded commit.

OMS protects the current branch and every reliably resolved baseline, including both sides of baseline metadata drift. It refuses ambiguous or malformed baseline metadata rather than risk deleting a protected branch. It also refuses deletion while a merge, rebase, cherry-pick, revert, bisect, or sequencer operation is in progress.

Safe deletion uses Git's merged-branch check first. Force deletion requires an explicit choice. Before force deletion, OMS prints the branch tip and a recreation command, then checks the tip again. If another process moved the branch, deletion stops rather than discarding an unexpected commit.

## Partial success and preserved state

Multi-repository operations isolate failures by alias and summarize partial success. Root finalization records only successful aliases and preserves unrelated staged paths.

When finalizing repository registration or metadata, OMS writes durable recovery state before replacing the main index. If interruption leaves finalization state behind, `oms sync`, `oms unsync`, and `oms record` run a shared recovery preflight. They either complete the known operation safely or stop before making another main-project change.

Automation is bounded by user intent. OMS performs deterministic preparation, but asks before choices such as registering a missing repository. When it cannot continue safely, the error names the failed operation, describes preserved state, and points to an OMS command or limited Git repair.

## Recovery checklist

1. Run `oms status` to identify the affected repository and Git boundary.
2. Run `oms doctor` to diagnose the manifest, Git-root identity, registrations, and installed skill versions.
3. Follow the specific `oms sync`, `oms branch switch`, or `oms record` command printed by the failure.
4. Use manual Git repair only when the error explicitly calls for it; keep the repair limited to the named repository and paths.

See [Commands](commands.md) to choose a command. Exact flags and exit behavior remain authoritative in `oms <command> --help`.
