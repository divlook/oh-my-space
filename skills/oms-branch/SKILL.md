---
name: oms-branch
description: Use to inspect, create, switch, or delete source branches in OMS, or to choose a separate task checkout.
compatibility: Requires oh-my-space >=3.0.0-0.
metadata:
  author: oh-my-space
  version: "2.0.0"
  oh-my-space-version: ">=3.0.0-0"
---

# Choose a source branch

Each `oms/<alias>/` directory is a separate Git repository.
A **detached HEAD** means the checkout refers directly to a commit instead of a branch.
Use a branch for new source commits.

## Scope guardrail

- Run `oms status --json` before Git work involving `oms/` and check `schemaVersion: 2`. Use `oms status --help` for the installed version's fields.
- Choose the repository that owns the change: the workspace root for shared files, or the independent `oms/<alias>/` checkout for source work.
- Commit and push in the intended source checkout without a root pointer step.
- Use plain Git inside managed trees at `.oms-tree/<alias>/<task>/`.

## Choose the command

1. Run `oms branch list <alias>` to inspect local and remote branches.
   OMS refreshes the declared remotes in the selected checkout.
2. Select the command that matches the task:
   - For a new or existing local branch, run `oms branch switch <alias> <branch>`.
     OMS creates a missing local branch.
     This command does not require a remote branch.
   - For an existing branch on `origin`, run `oms branch checkout <alias> <branch>`.
     OMS fetches `origin`.
     It creates a local tracking branch or selects the existing local branch.
3. Check `oms status --json` for the selected branch.
   Both commands attach HEAD to a branch.
   If the checkout is detached, use `oms branch switch` before a source commit.
   A raw `git checkout <sha>` detaches HEAD.

## Use a separate task checkout

For a second task or an unchanged canonical checkout, use `oms tree add <alias> <task>`.
The managed tree resides at `.oms-tree/<alias>/<task>/` on branch `<task>`.
The canonical checkout remains unchanged.
Read `oms tree add --help` before selecting options.
Use the managed-tree procedure in the `oms-workspace` skill for work inside the tree.

## Delete a local branch

1. Run `oms branch delete <alias> <branch>` for safe local deletion.
   Omit the alias or branch for interactive selection.
   OMS displays protected branches but prevents their selection.
2. If safe deletion fails, check whether the branch contains unmerged commits.
   Use `--force` only when you intend to lose those commits.
   Force still protects the current branch and baseline branches.

OMS deletes neither remote branches nor remote-tracking references.
Use this command instead of raw `git branch -d` or `git branch -D` to retain baseline protection.
For a remote branch deletion, use Git directly against the remote.

## Command reference

Read the relevant command's help for fields, preparation, freshness, options, and exit behavior:

- `oms branch list --help`
- `oms branch switch --help`
- `oms branch checkout --help`
- `oms branch delete --help`
