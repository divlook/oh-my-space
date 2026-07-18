---
name: oms-pointer
description: Use after `oms commit` or `oms pull` moves a submodule's working commit, to record the moved root gitlink pointer with `oms record`. Covers the cross-command commit-or-pull-then-record loop so a submodule source change is not left without a recorded root pointer, and the root pointer is not committed by mistake.
---

# Record the root pointer after a submodule commit moves

When a submodule's working commit moves — because you ran `oms commit` to commit source changes, or `oms pull` fast-forwarded its branch — the root repository's gitlink still points at the old commit until you record the new one. Recording is a separate, explicit step.

## Scope guardrail (applies before any Git work)

- Run `oms status --json` before Git work involving `.oms/` or `oms/`; require schemaVersion 2 and use `oms status --help` if another version appears.
- Read `mode`, `currentTarget`, the root relation, and each repository discriminator before choosing a Git scope.
- Treat root operations, alias-scoped repository operations, and worktree-mode `alias/name` checkout operations as different scopes; never guess.
- In submodule mode, record an existing pointer only when the user explicitly runs `oms record <alias>`; worktree mode has no root pointer record.
- Check `oms <command> --help` for exact mode-specific targets, flags, and recovery behavior.

## Commit source, then record the pointer

1. Confirm status schema v2 reports `mode: submodule`; in worktree mode, stop because no pointer-record step exists.
2. Commit the submodule's source changes with `oms commit <alias> -m "<message>"`. This commits inside `oms/<alias>/` only.
3. Record the moved root pointer afterward with `oms record <alias>`.

## A pull that fast-forwards also moves the pointer

`oms pull <alias>` fast-forwards the submodule branch and moves its working commit, so it moves the root pointer the same way a commit does. Record it with `oms record <alias>` afterward, exactly as after `oms commit`.

## Do not commit the root pointer by mistake

Do not stage and commit the root gitlink yourself to capture a pointer move — that is what `oms record <alias>` is for, and doing it by hand is the mistake this workflow exists to prevent. Run `oms status --json` to confirm whether a pointer is unrecorded before and after.

These instructions require `oms status --json` schemaVersion 2. If another version appears, stop and use `oms status --help`. Defer remaining detail to `oms commit --help`, `oms pull --help`, and `oms record --help`.
