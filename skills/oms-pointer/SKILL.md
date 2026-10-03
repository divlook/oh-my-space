---
name: oms-pointer
description: Use after oms commit or oms pull changes a source commit, when the task includes recording the main-project pointer.
compatibility: Requires oh-my-space >=1.0.0-0.
metadata:
  author: oh-my-space
  version: "1.2.0"
  oh-my-space-version: ">=1.0.0-0"
---

# Record a moved pointer

`oms commit` and `oms pull` can change a source repository's current commit.
The main project still records the previous commit until `oms record` creates a pointer commit.
A **pointer** is the gitlink that stores the source commit in the main project.

## Scope guardrail

- Run `oms status --json` before Git work involving `oms/` to identify the main project and each source repository.
- Treat each `oms/<alias>/` directory as a separate Git repository.
- Use `oms` commands for workflows in `oms/<alias>/`.
- Create main-project commits for existing pointer updates only when the user explicitly runs `oms record <alias>`.

## Commit source changes

1. Commit source changes with `oms commit <alias> -m "<message>"`.
   The command requires `-m`.
   It commits only inside `oms/<alias>/`.
2. Push the source commit with `oms push <alias>`.
   Collaborators must be able to fetch the commit before the main project records it.
3. Continue to the recording procedure only when the scope guardrail permits a pointer commit.

## After a pull

`oms pull <alias>` can advance the source branch through a fast-forward.
A fast-forward moves the branch to a descendant commit without a merge commit.
The resulting pointer update needs the same recording procedure as a source commit.
`oms push` does not move the source checkout or record its pointer.

## Record the selected pointers

1. Check `oms status --json` for unrecorded pointer updates.
2. Run `oms record <alias>` for the selected repository.
   For several selected repositories, use `oms record <alias> <alias>`.
   Use `oms record --all` only when the request includes every moved pointer.
   OMS records successful selections in one main-project commit.
3. Check the command's exit status.
   A non-zero status can indicate partial success.
   Read each skipped alias's reason.
4. Check `oms status --json` again.
   Account for every selected pointer and any skipped alias.

Use `oms record` instead of a manual gitlink commit.
These instructions use `oms status --json` schemaVersion 1.
For another schemaVersion, read `oms status --help` for the installed version's field definitions.
Read the relevant command's help before selecting options:

- `oms commit --help`
- `oms pull --help`
- `oms push --help`
- `oms record --help`
