---
"oh-my-space": minor
---

Add installable `oms` workspace skills and an `oms skills` command.

Three agent skills are now published under `skills/<name>/SKILL.md` and installable with the external `skills` tool (`npx skills add divlook/oh-my-space`, `-g` for a global install, `--skill <name>` for one, `--list` to list them):

- `oms-workspace` — establishes workspace state and root-versus-submodule scope before scope-ambiguous Git work, and separates repo add/remove topology (`oms sync`/`oms unsync`) from recording a moved pointer (`oms record`).
- `oms-pointer` — records the root pointer with `oms record` after `oms commit` or `oms pull` moves a submodule's commit.
- `oms-branch` — chooses `oms switch` (new local branch) versus `oms checkout` (track a remote branch) and avoids detached HEAD.

Each skill carries the scope-guardrail kernel verbatim (single-sourced with the `oms/` marker block, drift-tested) and defers exact `oms status --json` field semantics to `oms status --help`. The new `oms skills` command prints the project-scope and `-g` global install commands, and `oms skills --install` resolves to the workspace root and delegates to `npx skills add`, forwarding extra arguments straight through.
