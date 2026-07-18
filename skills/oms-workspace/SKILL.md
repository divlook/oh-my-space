---
name: oms-workspace
description: Use for scope-ambiguous Git work in any workspace containing an `oms.yaml`, including submodule topology and pointers or worktree-mode managed checkout lifecycle. Establishes mode, target, and repository scope before acting.
---

# oms workspace scope

An `oms` workspace uses one workspace-wide repository mode. Submodule mode stores one checkout at `oms/<alias>` and records a root gitlink. Worktree mode stores common repositories under `.oms/repos/` and addresses concurrent checkouts as `alias/name`, without root pointer records.

## Scope guardrail (applies before any Git work)

- Run `oms status --json` before Git work involving `.oms/` or `oms/`; require schemaVersion 2 and use `oms status --help` if another version appears.
- Read `mode`, `currentTarget`, the root relation, and each repository discriminator before choosing a Git scope.
- Treat root operations, alias-scoped repository operations, and worktree-mode `alias/name` checkout operations as different scopes; never guess.
- In submodule mode, record an existing pointer only when the user explicitly runs `oms record <alias>`; worktree mode has no root pointer record.
- Check `oms <command> --help` for exact mode-specific targets, flags, and recovery behavior.

## Decide the scope first

1. Run `oms status --json` and require `schemaVersion: 2`.
2. Choose root, alias, or `alias/name` scope from `mode`, current context, and repository discriminators.
3. In submodule mode only, use `oms record <alias>` for an explicitly requested moved pointer. Never suggest it in worktree mode.

These instructions require `oms status --json` schemaVersion 2. If another version appears, stop and use `oms status --help` for the installed contract.

## Adding or removing a repo is topology, not a pointer record

Adding or removing a repo changes the root topology — the `.gitmodules` entry and the `oms/<alias>` gitlink — which is different from recording a moved pointer:

- `oms sync <alias>` (add or refresh) and `oms unsync <alias>` (remove) stage that root topology and commit it with `--commit`. Run non-interactively without `--commit`, the topology is left unstaged for the user to commit.
- `oms record <alias>` records a moved pointer only; it refuses adds and removals.

So when `oms sync` or `oms unsync` leaves the topology unstaged, finish it with `oms sync --commit` or `oms unsync --commit` (or commit it yourself) — do not reach for `oms record`, which will refuse. Defer remaining flag detail to `oms sync --help` and `oms unsync --help`.
