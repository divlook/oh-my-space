---
name: oms-branch
description: Use when starting or switching a branch inside an `oms/<alias>/` submodule — `oms switch` to create or move to a local branch, `oms checkout` to check out an existing remote branch as a tracking branch. Helps avoid leaving a submodule in detached HEAD.
---

# Choose the right branch command inside a submodule

Branching happens inside a submodule (`oms/<alias>/`), which is its own Git repository. Picking the wrong command can leave the submodule in detached HEAD, where new commits are not on any branch and the root pointer cannot be recorded cleanly.

## Scope guardrail (applies before any Git work)

- Run `oms status --json` before Git work involving `oms/` to read root versus submodule state.
- Treat each `oms/<alias>/` directory as a separate Git repository.
- Use `oms` commands for scoped submodule workflows; do not guess root repository versus submodule Git scope.
- Do not create root commits for existing submodule pointer updates unless the user explicitly runs `oms record <alias>`.

## Switch versus checkout

- `oms switch <alias> <branch>` starts or moves to a LOCAL branch, creating it locally if it does not exist yet. No remote is required. Use this to begin new work.
- `oms checkout <alias> <branch>` fetches `origin` and checks out an existing REMOTE branch (`origin/*`) as a local tracking branch. Use this to continue work that already exists on the remote.

## Avoid detached HEAD

Both commands attach HEAD to a branch. Prefer them over a raw `git checkout <sha>` inside the submodule, which detaches HEAD. If `oms status --json` shows a submodule with no branch (detached), attach one with `oms switch` before committing.

These instructions were written against `oms status --json` schemaVersion 1. If `oms status --json` reports a different schemaVersion, defer to `oms status --help` for exact field semantics. Defer remaining flag detail to `oms switch --help` and `oms checkout --help`.
