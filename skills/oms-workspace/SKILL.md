---
name: oms-workspace
description: Use for Git work in a workspace containing an `oms.yaml` (source repos vendored as submodules under `oms/`) whenever the repository scope is ambiguous — committing or pushing "everything" from the workspace root, interpreting an `oms status` pointer that has moved, debugging a push, or adding or removing a repo with `oms sync` or `oms unsync`. Establishes workspace state and root-versus-submodule scope before acting on Git.
compatibility: Requires oh-my-space >=1.0.0-0.
metadata:
  author: oh-my-space
  version: "1.2.0"
  oh-my-space-version: ">=1.0.0-0"
---

# oms workspace scope

An `oms` workspace keeps each source repository as a Git submodule under `oms/<alias>/`. The root repository tracks only a pointer (gitlink) to each submodule's commit, so the same Git command means different things at the root versus inside a submodule. Establish where you are before acting.

## Scope guardrail (applies before any Git work)

- Run `oms status --json` before Git work involving `oms/` to read root versus submodule state.
- Treat each `oms/<alias>/` directory as a separate Git repository.
- Use `oms` commands for scoped submodule workflows; do not guess root repository versus submodule Git scope.
- Do not create root commits for existing submodule pointer updates unless the user explicitly runs `oms record <alias>`.

## Decide the scope first

1. Run `oms status --json` and read the result. It reports the workspace root, the current alias (when you are inside `oms/<alias>/`), root pointer movement under `root.submodulePointers`, and each submodule's branch, dirtiness, and ahead-behind state.
2. Choose the scope from that state — do not guess. Source-code changes belong inside `oms/<alias>/` (the submodule); the root repository only records pointers and topology.
3. Never create a root pointer commit unless the user explicitly asks for one. Moved pointers are recorded with `oms record` — naming the aliases, or `--all` for every moved pointer — not by committing the root gitlink directly.

These instructions were written against `oms status --json` schemaVersion 1. If `oms status --json` reports a different schemaVersion, defer to `oms status --help` for exact field semantics; `oms status --help` ships with the installed CLI and always matches the emitted schemaVersion.

## Adding or removing a repo is topology, not a pointer record

Adding or removing a repo changes the root topology — the `.gitmodules` entry and the `oms/<alias>` gitlink — which is different from recording a moved pointer:

- `oms sync <alias>` (add or refresh) and `oms unsync <alias>` (remove) stage that root topology and commit it with `--commit`. Run non-interactively without `--commit`, the topology is left unstaged for the user to commit.
- `oms record <alias>` records moved pointers only; it refuses adds and removals. It also accepts several aliases and `--all`, recording them in one root commit.

So when `oms sync` or `oms unsync` leaves the topology unstaged, finish it with `oms sync --commit` or `oms unsync --commit` (or commit it yourself) — do not reach for `oms record`, which will refuse. Defer remaining flag detail to `oms sync --help` and `oms unsync --help`.

## Managed trees are Git-direct scope

For task work that needs its own checkout of a source repository, OMS creates a managed tree — a disposable Git worktree at `.oms-tree/<alias>/<task>/` layered on the submodule's own history. Inside a managed tree, OMS alias commands are the wrong tool:

- Use plain Git directly inside `.oms-tree/<alias>/<task>/` — commit, branch, push as you would in any repository. `oms commit`, `oms push`, `oms branch`, `oms fetch`, `oms pull`, and `oms record` refuse to run from inside a managed tree.
- Run `oms` commands from the canonical checkout (`oms/<alias>/`) or the workspace root, never from inside `.oms-tree/`.
- Push and open a pull request from the tree. When the PR merges, reflect the result in the canonical checkout: run `oms pull <alias>`, then `oms record <alias>` — the pull moves the submodule branch, the record commits the moved root pointer.
- `oms status` reports managed trees (the `trees` array in `oms status --json`); `oms doctor` reports broken tree links. Defer remaining tree detail to `oms tree --help`.
